# MACHORA API

Express and MongoDB API for equipment, favorites, rentals, and administration.

Live URL: Pending deployment.

## Run locally

1. Run `npm ci` with Node.js 24+.
2. Copy `.env.example` to `.env` if needed. Set `MONGODB_URL` to the same MongoDB deployment used by the frontend. MongoDB Atlas or another replica set is required because bookings use transactions.
3. Set `FRONTEND_URL` to the exact frontend origin and run `npm start`.
4. The health route is `GET /`. Protected routes accept the short-lived Better Auth JWT and check the current MongoDB user role.

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

### Add a payment gateway later

The `POST /bookings` route is the integration point. It owns the calculation and availability check. For online checkout, create a short-lived pending reservation here and start the provider checkout using the server-calculated amount. Add a signed webhook to reconcile successful payments. In one transaction, save each unique provider transaction ID in a payments collection and update the matching booking to Paid and Confirmed. Expire unpaid reservations and release stock. Keep gateway secrets in this server's environment. Keep the existing **Mark paid** action for offline payments.

### Packages

- Express for routing and middleware.
- MongoDB driver for collections, indexes, and booking transactions.
- CORS for frontend origin access.
- dotenv for local environment configuration.
- Node's crypto module for JWT signature verification against Better Auth's public keys.

## Submission

Deploy frontend and API, then add their live links to both READMEs. Verify a fresh page load, a reload on a protected route, Google login, and a rental from listing approval through manual payment. Share the two repository URLs and examiner credentials through your course submission channel.
