import Stripe from "stripe";

const currency = "bdt";

export function createStripePayments({ client, bookings, payments, frontendOrigin, secretKey, webhookSecret }) {
  const stripe = secretKey && webhookSecret ? new Stripe(secretKey, { timeout: 15_000, maxNetworkRetries: 1 }) : null;

  async function createCheckout(booking) {
    const id = booking._id.toString();
    return stripe.checkout.sessions.create({
      mode: "payment",

      client_reference_id: id,
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
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
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
