import "dotenv/config";
import cors from "cors";
import express from "express";
import { createPublicKey, verify } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

// Database, server settings, and authentication
const port = process.env.PORT || 5000;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
const frontendOrigin = new URL(frontendUrl).origin;
// The frontend and API use the same MongoDB database.
const client = new MongoClient(process.env.MONGODB_URL);
const db = client.db("machineRentbd");
const users = db.collection("user");
const equipment = db.collection("equipment");
const bookings = db.collection("bookings");
const favorites = db.collection("favorites");
const payments = db.collection("payments");
const stripePayments = createStripePayments({
  client, bookings, payments, frontendOrigin,
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
});
const userFields = { name: 1, email: 1, role: 1, createdAt: 1, image: 1 };
const daysPerPeriod = { Daily: 1, Weekly: 7, Monthly: 30 };

// Route helpers throw errors for the JSON error handler in index.js.
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function objectId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) fail(404, "Item not found.");
  return new ObjectId(value);
}

// Better Auth issues the token. Its public key lets the API verify the signature.
async function verifyToken(req, res, next) {
  const token = req.get("authorization")?.match(/^Bearer ([\w.-]+)$/)?.[1];
  if (!token) return res.status(401).json({ message: "Please sign in." });

  let subject;
  try {
    const [header, payload, signature, extra] = token.split(".");
    if (extra || !signature) throw new Error();
    const { kid, alg } = JSON.parse(Buffer.from(header, "base64url"));
    if (alg !== "EdDSA" || typeof kid !== "string") throw new Error();
    const response = await fetch(frontendOrigin + "/api/auth/jwks", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const { keys } = await response.json();
    const key = createPublicKey({ key: keys.find((item) => item.kid === kid), format: "jwk" });
    const signedData = Buffer.from(header + "." + payload);
    const signatureBytes = Buffer.from(signature, "base64url");
    if (!verify(null, signedData, key, signatureBytes)) throw new Error();

    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    if (claims.iss !== frontendOrigin || claims.aud !== "machora-api") throw new Error();
    if (!Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw new Error();
    subject = objectId(claims.sub);
  } catch {
    return res.status(401).json({ message: "Your session could not be verified." });
  }

  // Read the current role from MongoDB so an old token cannot keep elevated permissions.
  req.user = await users.findOne({ _id: subject }, { projection: userFields });
  if (!req.user) return res.status(401).json({ message: "Account unavailable." });
  next();
}

// Add a role check after verifyToken on routes that have restricted access.
function allowRole(role) {
  return (req, res, next) => {
    if ((req.user.role || "Customer") !== role) return res.status(403).json({ message: "Access denied." });
    next();
  };
}
const verifyRenter = allowRole("Customer");
const verifyOwner = allowRole("Owner");
const verifyAdmin = allowRole("Admin");

// Stripe Checkout and signed webhooks
const currency = "bdt";

function createStripePayments({ client, bookings, payments, frontendOrigin, secretKey, webhookSecret }) {
  const stripe = secretKey && webhookSecret ? new Stripe(secretKey, { timeout: 15_000, maxNetworkRetries: 1 }) : null;

  async function createCheckout(booking) {
    const id = booking._id.toString();
    return stripe.checkout.sessions.create({
      mode: "payment",      client_reference_id: id,
      metadata: { bookingId: id },
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: Math.round(booking.total * 100),
          product_data: { name: booking.equipmentName },
        },
      }],
      success_url: frontendOrigin + "/payment/success?booking=" + id,
      cancel_url: frontendOrigin + "/payment/cancel?booking=" + id,
    }, { idempotencyKey: "machora-booking-" + id });
  }

  async function cancelCheckout(sessionId) {
    const checkout = await stripe.checkout.sessions.retrieve(sessionId);
    if (checkout.status === "expired") return true;
    if (checkout.status !== "open") return false;
    const expired = await stripe.checkout.sessions.expire(sessionId);
    return expired.status === "expired";
  }

  async function handleWebhook(req, res) {
    if (!stripe) return res.status(503).json({ message: "Stripe is not configured." });

    let event;
    try {
      // Stripe signs the raw request bytes, so verify them before reading the event.
      event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), webhookSecret);
    } catch {
      return res.status(400).json({ message: "Invalid Stripe signature." });
    }

    const checkout = event.data.object;
    const match = { stripeSessionId: checkout.id, paymentMethod: "Stripe", status: "Awaiting payment" };

    if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      await bookings.updateOne(match, { $set: { status: "Cancelled", paymentStatus: "Unpaid" } });
    } else if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && checkout.payment_status === "paid") {
      await client.withSession((session) => session.withTransaction(async () => {
        const booking = await bookings.findOne(match, { session });
        if (!booking) return;
        if (
          checkout.client_reference_id !== booking._id.toString() ||
          checkout.currency !== currency ||
          checkout.amount_total !== Math.round(booking.total * 100)
        ) throw new Error("Stripe payment does not match the booking.");

        const paidAt = new Date();
        // The booking ID is unique in payments, so webhook retries cannot record a second payment.
        await payments.updateOne({ _id: booking._id }, {
          $setOnInsert: {
            bookingId: booking._id, customerId: booking.customerId, ownerId: booking.ownerId,
            provider: "Stripe", sessionId: checkout.id, paymentIntentId: checkout.payment_intent,
            amount: checkout.amount_total, currency, paidAt,
          },
        }, { session, upsert: true });
        await bookings.updateOne(match, {
          $set: { status: "Confirmed", paymentStatus: "Paid", paidAt },
        }, { session });
      }));
    }

    res.json({ received: true });
  }

  return { enabled: Boolean(stripe), createCheckout, cancelCheckout, handleWebhook };
}

// Express setup: Stripe needs the original request body before JSON parsing.
const app = express();
app.use(cors({ origin: frontendOrigin }));
app.post("/payments/stripe/webhook", express.raw({ type: "application/json" }), stripePayments.handleWebhook);
app.use(express.json());
app.get("/", (_, res) => res.json({ status: "ok", app: "MACHORA" }));

// Equipment and favorites
// Public catalog. MongoDB applies the filters, sorting, and featured limit.
app.get("/equipment", async (req, res) => {
  const { search, category, rentalType, min, max, availability, sort, featured } = req.query;
  const filter = { status: "Approved" };
  if (typeof search === "string" && search.trim()) {
    const pattern = new RegExp(RegExp.escape(search.trim().slice(0, 100)), "i");
    filter.$or = [{ name: pattern }, { category: pattern }, { location: pattern }];
  }
  if (typeof category === "string" && category) filter.category = category;
  if (typeof rentalType === "string" && Object.hasOwn(daysPerPeriod, rentalType)) filter.rentalType = rentalType;
  if (availability === "available") filter.quantity = { $gt: 0 };
  if (availability === "unavailable") filter.quantity = 0;
  const priceRange = {};
  if (min && Number.isFinite(Number(min))) priceRange.$gte = Number(min);
  if (max && Number.isFinite(Number(max))) priceRange.$lte = Number(max);
  if (Object.keys(priceRange).length > 0) filter.price = priceRange;

  let order = { createdAt: -1 };
  if (sort === "low") order = { price: 1 };
  if (sort === "high") order = { price: -1 };
  const query = equipment.find(filter).sort(order);
  if (featured === "true") query.limit(6);
  res.json(await query.toArray());
});

app.get("/equipment/:id", verifyToken, async (req, res) => {
  const item = await equipment.findOne({ _id: objectId(req.params.id) });
  if (!item || (item.status !== "Approved" && req.user.role !== "Admin" && !item.ownerId?.equals(req.user._id))) fail(404, "Equipment unavailable.");
  res.json(item);
});

// Both create and edit requests use the same listing validation.
function equipmentFields(body) {
  const fields = {};
  for (const key of ["name", "description", "category", "location", "condition", "brand", "model", "image", "terms", "rentalType"]) {
    fields[key] = typeof body[key] === "string" ? body[key].trim().slice(0, 2000) : "";
    if (!fields[key]) fail(400, "Please fill all equipment fields.");
  }
  if (!/^https?:\/\//i.test(fields.image)) fail(400, "Enter a direct image URL.");
  fields.price = Number(body.price);
  fields.quantity = Number(body.quantity);
  if (!Object.hasOwn(daysPerPeriod, fields.rentalType) || !Number.isFinite(fields.price) || fields.price <= 0 || !Number.isSafeInteger(fields.quantity) || fields.quantity < 0) fail(400, "Check price, quantity, and rental type.");
  return fields;
}

app.post("/owner/equipment", verifyToken, verifyOwner, async (req, res) => {
  const item = { ...equipmentFields(req.body), status: "Pending", ownerId: req.user._id, ownerName: req.user.name, createdAt: new Date() };
  const result = await equipment.insertOne(item);
  res.status(201).json({ id: result.insertedId });
});

app.get("/owner/equipment", verifyToken, verifyOwner, async (req, res) => {
  res.json(await equipment.find({ ownerId: req.user._id }).toArray());
});

// Owners can edit their own listings. Admins can edit or review any listing.
function manageEquipment(scope) {
  const checkRole = scope === "owner" ? verifyOwner : verifyAdmin;
  const path = "/" + scope + "/equipment/:id";
  const match = (req) => ({
    _id: objectId(req.params.id),
    ...(scope === "owner" ? { ownerId: req.user._id } : {}),
  });
  app.patch(path, verifyToken, checkRole, async (req, res) => {
    const status = req.body.status;
    let update;
    if (scope === "admin" && ["Approved", "Rejected", "Pending"].includes(status)) {
      update = { status };
    } else {
      update = equipmentFields(req.body);
      if (scope === "owner") update.status = "Pending";
    }

    const result = await equipment.updateOne(match(req), { $set: update });
    if (result.matchedCount === 0) fail(404, "Equipment not found.");
    res.json({ ok: true });
  });
  app.delete(path, verifyToken, checkRole, async (req, res) => {
    if (!(await equipment.deleteOne(match(req))).deletedCount) fail(404, "Equipment not found.");
    res.json({ ok: true });
  });
}
manageEquipment("owner");
manageEquipment("admin");

app.get("/admin/equipment", verifyToken, verifyAdmin, async (_, res) => res.json(await equipment.find().toArray()));

// Keep each favorites list scoped to the signed-in customer.
app.get("/favorites", verifyToken, verifyRenter, async (req, res) => {
  const saved = await favorites.find({ customerId: req.user._id }).toArray();
  res.json(await equipment.find({ _id: { $in: saved.map((row) => row.equipmentId) }, status: "Approved" }).toArray());
});
app.put("/favorites/:id", verifyToken, verifyRenter, async (req, res) => {
  const equipmentId = objectId(req.params.id);
  if (!(await equipment.findOne({ _id: equipmentId, status: "Approved" }))) fail(404, "Equipment not found.");
  await favorites.updateOne({ customerId: req.user._id, equipmentId }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  res.json({ ok: true });
});
app.delete("/favorites/:id", verifyToken, verifyRenter, async (req, res) => {
  await favorites.deleteOne({ customerId: req.user._id, equipmentId: objectId(req.params.id) });
  res.json({ ok: true });
});

// Admin user management
const adminUserFields = { ...userFields, phone: 1, address: 1 };
const roles = ["Customer", "Owner", "Admin"];

app.get("/admin/users", verifyToken, verifyAdmin, async (_, res) => res.json(await users.find({}, { projection: adminUserFields }).toArray()));
// Edit profile fields only. The role endpoint handles permissions separately.
app.patch("/admin/users/:id/profile", verifyToken, verifyAdmin, async (req, res) => {
  const limits = { name: 100, phone: 40, address: 400, image: 2048 };
  const profile = {};
  for (const [field, maxLength] of Object.entries(limits)) {
    const value = req.body?.[field];
    if (typeof value !== "string" || value.trim().length > maxLength) {
      fail(400, "Check the profile fields and try again.");
    }
    profile[field] = value.trim();
  }
  if (!profile.name) fail(400, "Enter the user's name.");
  if (profile.image && (!URL.canParse(profile.image) || !/^https?:\/\//i.test(profile.image))) {
    fail(400, "Enter a valid photo URL.");
  }
  const user = await users.findOneAndUpdate(
    { _id: objectId(req.params.id) },
    { $set: { ...profile, image: profile.image || null, updatedAt: new Date() } },
    { projection: adminUserFields, returnDocument: "after" },
  );
  if (!user) fail(404, "User not found.");
  res.json(user);
});

app.patch("/admin/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  const id = objectId(req.params.id);
  if (id.equals(req.user._id)) fail(400, "Use another administrator to update your role.");
  if (!roles.includes(req.body.role)) fail(400, "Choose a valid role.");
  if (!(await users.updateOne({ _id: id }, { $set: { role: req.body.role } })).matchedCount) fail(404, "User not found.");
  res.json({ ok: true });
});

// Bookings and payment status
const millisecondsPerDay = 86_400_000;

// Parse calendar dates as UTC days so rental totals use whole dates.
function parseDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, "Choose valid rental dates.");
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) fail(400, "Choose valid rental dates.");
  return date;
}

app.post("/bookings", verifyToken, verifyRenter, async (req, res) => {
  const equipmentId = objectId(req.body.equipmentId);
  const paymentMethod = req.body.paymentMethod ?? "Manual";
  if (!["Manual", "Cash on delivery", "Stripe"].includes(paymentMethod)) {
    fail(400, "Choose a supported payment method.");
  }
  const payOnline = paymentMethod === "Stripe";
  if (payOnline && !stripePayments.enabled) fail(503, "Online payment is not configured.");
  const start = parseDay(req.body.start);
  const end = parseDay(req.body.end);
  // Count both the first and last rental day.
  const days = (end.getTime() - start.getTime()) / millisecondsPerDay + 1;
  const quantity = Number(req.body.quantity);
  const phone = String(req.body.phone || "").trim().slice(0, 40);
  const address = String(req.body.address || "").trim().slice(0, 400);
  const today = new Date().toISOString().slice(0, 10);
  const validDates = req.body.start >= today && days >= 1 && days <= 365;
  const validQuantity = Number.isSafeInteger(quantity) && quantity > 0;
  if (!validDates || !validQuantity || !phone || !address) {
    fail(400, "Check your dates, quantity, phone, and address.");
  }

  const booking = await client.withSession((session) => session.withTransaction(async () => {
    // Updating this item first serializes concurrent reservations for the same equipment.
    const item = await equipment.findOneAndUpdate({ _id: equipmentId, status: "Approved" }, { $inc: { bookingVersion: 1 } }, { session, returnDocument: "after" });
    if (!item) fail(404, "Equipment unavailable.");
    const overlappingBookings = await bookings.find({
      equipmentId,
      $or: [
        { status: "Confirmed" },
        { status: "Awaiting payment", stripeSessionId: { $exists: true } },
        { status: "Awaiting payment", checkoutSetupDeadline: { $gt: new Date() } },
      ],
      start: { $lte: end },
      end: { $gte: start },
    }, { session }).toArray();

    // Check stock for each day because bookings can overlap only part of the rental.
    for (let day = start.getTime(); day <= end.getTime(); day += millisecondsPerDay) {
      let reserved = 0;
      for (const booking of overlappingBookings) {
        if (Number(booking.start) <= day && Number(booking.end) >= day) {
          reserved += booking.quantity;
        }
      }
      if (reserved + quantity > item.quantity) fail(409, "This quantity is unavailable for the selected dates.");
    }
    // Round partial weeks or months up to a full rental period.
    const billablePeriods = Math.ceil(days / daysPerPeriod[item.rentalType]);
    const total = Math.round(item.price * billablePeriods * quantity * 100) / 100;
    if (payOnline && (!Number.isFinite(total) || total <= 0)) fail(400, "This rental does not have a valid online price.");
    const reservation = {
      _id: new ObjectId(),
      equipmentId, equipmentName: item.name, customerId: req.user._id,
      customerName: req.user.name, ownerId: item.ownerId, ownerName: item.ownerName,
      start, end, days, quantity, total, phone, address,
      notes: String(req.body.notes || "").slice(0, 1000),
      status: payOnline ? "Awaiting payment" : "Confirmed",
      paymentStatus: "Unpaid", paymentMethod, createdAt: new Date(),
      ...(payOnline ? { checkoutSetupDeadline: new Date(Date.now() + 5 * 60_000) } : {}),
    };
    await bookings.insertOne(reservation, { session });
    return reservation;
  }));

  if (!payOnline) return res.status(201).json({ id: booking._id });

  try {
    const checkout = await stripePayments.createCheckout(booking);
    if (!checkout.url) throw new Error("Stripe did not return a Checkout URL.");
    await client.withSession((session) => session.withTransaction(async () => {
      // Use the same equipment lock as the stock check while making the hold permanent.
      const listing = await equipment.updateOne({ _id: equipmentId, status: "Approved" }, { $inc: { bookingVersion: 1 } }, { session });
      const hold = await bookings.updateOne(
        { _id: booking._id, status: "Awaiting payment", checkoutSetupDeadline: { $gt: new Date() } },
        { $set: { stripeSessionId: checkout.id }, $unset: { checkoutSetupDeadline: "" } },
        { session },
      );
      if (!listing.matchedCount || !hold.matchedCount) throw new Error("The checkout reservation is unavailable.");
    }));
    res.status(201).json({ id: booking._id, checkoutUrl: checkout.url });
  } catch (error) {
    // No Checkout URL was returned to the customer, so this hold can be released.
    await bookings.updateOne({ _id: booking._id, status: "Awaiting payment" }, { $set: { status: "Cancelled" } });
    console.error("Stripe checkout setup failed:", error.name);
    fail(502, "Could not start online payment. Please try again.");
  }
});

app.get("/bookings/:id/payment", verifyToken, verifyRenter, async (req, res) => {
  const booking = await bookings.findOne(
    { _id: objectId(req.params.id), customerId: req.user._id, paymentMethod: "Stripe" },
    { projection: { equipmentId: 1, equipmentName: 1, paymentStatus: 1, status: 1 } },
  );
  if (!booking) fail(404, "Booking not found.");
  res.json(booking);
});

app.post("/bookings/:id/payment/cancel", verifyToken, verifyRenter, async (req, res) => {
  if (!stripePayments.enabled) fail(503, "Online payment is not configured.");
  const filter = { _id: objectId(req.params.id), customerId: req.user._id, paymentMethod: "Stripe" };
  const booking = await bookings.findOne(filter);
  if (!booking) fail(404, "Booking not found.");
  if (booking.status === "Cancelled") return res.json({ ok: true });
  if (booking.status !== "Awaiting payment" || !booking.stripeSessionId) fail(409, "This checkout is no longer open.");
  let expired;
  try {
    expired = await stripePayments.cancelCheckout(booking.stripeSessionId);
  } catch {
    fail(502, "Could not cancel checkout. Please try again.");
  }
  if (!expired) fail(409, "This checkout is no longer open.");
  await bookings.updateOne({ ...filter, status: "Awaiting payment" }, { $set: { status: "Cancelled" } });
  res.json({ ok: true });
});

app.get("/bookings", verifyToken, async (req, res) => {
  // Admins see every rental. Owners and customers only see their own records.
  const filter = {};
  if (req.user.role === "Owner") {
    filter.ownerId = req.user._id;
  } else if (req.user.role !== "Admin") {
    filter.customerId = req.user._id;
  }
  res.json(await bookings.find(filter).sort({ createdAt: -1 }).toArray());
});

// Admins record manual payments and manage rental status here.
app.patch("/admin/bookings/:id", verifyToken, verifyAdmin, async (req, res) => {
  const update = {};
  if (["Confirmed", "Completed", "Cancelled"].includes(req.body.status)) update.status = req.body.status;
  if (["Paid", "Unpaid"].includes(req.body.paymentStatus)) update.paymentStatus = req.body.paymentStatus;
  if (!Object.keys(update).length) fail(400, "Choose a valid status.");
  // A cancelled rental cannot be reopened because its stock may have been reserved again.
  const filter = { _id: objectId(req.params.id) };
  if (update.status) filter.status = "Confirmed";
  if (update.paymentStatus || update.status === "Cancelled") filter.paymentMethod = { $ne: "Stripe" };
  if (update.status === "Completed") filter.end = { $lt: new Date(new Date().toISOString().slice(0, 10)) };
  if (!(await bookings.updateOne(filter, { $set: update })).matchedCount) fail(409, "The booking cannot be updated.");
  res.json({ ok: true });
});

// Error responses and server startup
app.use((_, res) => res.status(404).json({ message: "Route not found." }));
app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status === 500) console.error(error.name);
  res.status(status).json({ message: status === 500 ? "Server error." : error.message });
});

// Connect and prepare the indexes before accepting requests.
await client.connect();
await favorites.createIndex({ customerId: 1, equipmentId: 1 }, { unique: true });
await bookings.createIndex({ equipmentId: 1, start: 1, end: 1 });
await bookings.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });
app.listen(port, () => console.log("MACHORA API listening on port " + port));
