# MACHORA API

Express and MongoDB API for equipment, favorites, rentals, and administration.

Live URL: Pending deployment.

## Run locally

1. Run `npm ci` with Node.js 24+.
2. Copy `.env.example` to `.env` if needed. Set `MONGODB_URL` to the same MongoDB deployment used by the frontend. MongoDB Atlas or another replica set is required because bookings use transactions.
3. Set `FRONTEND_URL` to the exact frontend origin and run `npm start`.
4. The health route is `GET /`. Protected routes accept the short-lived Better Auth JWT and check the current MongoDB user role.

### Where to find the code

The API is in `index.js`. Its comments mark the database and authentication setup, Stripe payments, equipment, users, bookings, and server startup.

### First administrator

Register the account in the app. Then, in your own MongoDB shell, run the following with that account's email:

```js
db.getSiblingDB("machineRentbd").getCollection("user").updateOne(
  { email: "your-admin-email@example.com" },
  { $set: { role: "Admin" } }
)
```

Sign out and back in after changing the role. The Admin dashboard can assign Owner and Admin roles to other accounts.

### Add six demo listings

In a demo database, run `node seed-demo.js owner@example.com` with the email of an existing Owner. This adds six approved sample listings for that account. Use real listings for a public deployment.

### Stripe Checkout

1. Put your Stripe test secret key in the server’s private `.env` as `STRIPE_SECRET_KEY` (starts with `sk_test_`).
2. Log in to the [Stripe CLI](https://docs.stripe.com/cli/login.md) and forward events to the local API. Change port 8000 if the API uses another port.

   ```sh
   stripe listen --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed --forward-to http://localhost:8000/payments/stripe/webhook
   ```

3. Copy the listener's `whsec_` signing secret into `STRIPE_WEBHOOK_SECRET` in the server’s private `.env`, then start or restart Express. Keep the listener running while testing.
4. Sign in as a Customer and choose **Pay online** from a booking form. Checkout charges the server-calculated amount in BDT. The signed webhook confirms the booking and records the Stripe transaction in MongoDB. The success page checks the recorded payment status.

For deployment, register an HTTPS endpoint at `/payments/stripe/webhook` in Stripe for the same events. Use the deployed endpoint’s signing secret and set `FRONTEND_URL` to the live web address. Use matching test or live credentials. [Stripe webhook setup](https://docs.stripe.com/events/set-up-events.md)

Cash on delivery remains available. Admins can mark those bookings paid manually. An unpaid Stripe reservation releases its stock when Stripe confirms expiry or the customer cancels it.

### Packages

- Express for routing and middleware.
- Stripe SDK for hosted checkout and signed payment events.
- MongoDB driver for collections, indexes, and booking transactions.
- CORS for frontend origin access.
- dotenv for local environment configuration.
- Node's crypto module for JWT signature verification against Better Auth's public keys.

## Submission

Deploy frontend and API, then add their live links to both READMEs. Verify a fresh page load, a reload on a protected route, Google login, and a rental from listing approval through manual payment. Share the two repository URLs and examiner credentials through your course submission channel.
