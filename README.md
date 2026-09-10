# Shopify → Stripe Checkout

One dynamic Stripe Checkout Session is created for the complete Shopify cart. The browser sends only variant IDs, quantities, and the cart token. The backend reloads authoritative variant price, product status, and tracked inventory from Shopify Admin GraphQL. Stripe Tax calculates tax; existing Stripe shipping-rate IDs are explicitly configured by the merchant.

## Setup

1. Install Node.js 22+, PostgreSQL, and Stripe CLI.
2. Run `npm install` in this directory.
3. Copy `.env.example` to `.env.local` and fill every applicable value. For a new Dev Dashboard app on a store in your own organization, set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`; the server automatically obtains and refreshes Shopify's 24-hour access token. Set `SHOPIFY_ADMIN_ACCESS_TOKEN` only for an existing legacy admin-created custom app. `SHOPIFY_STOREFRONT_ORIGIN` must exactly match the public storefront origin. `STRIPE_SHIPPING_RATES` must contain real Stripe shipping-rate IDs whose currency matches the store currency. `SHIPPING_ALLOWED_COUNTRIES` must match the store's actual US/GB/CA shipping policy.
4. Run `psql "$DATABASE_URL" -f db/migrations/001_init.sql`.
5. In Stripe Dashboard enable Tax registrations for the jurisdictions where the business is registered and verify each configured shipping rate. Set `STRIPE_TAX_BEHAVIOR=inclusive` only when Shopify catalog prices include tax; otherwise use `exclusive`.
6. In the Shopify theme editor, Cart footer → Stripe checkout API URL, set `https://checkout.example.com/api/stripe/create-checkout-session`.
7. Start locally with `npm run dev`.

## Webhooks and testing

Run `stripe listen --forward-to localhost:3000/api/stripe/webhook`, copy the printed signing secret to `STRIPE_WEBHOOK_SECRET`, then run `stripe trigger checkout.session.completed`. For an end-to-end test, expose the app through an HTTPS tunnel, put that API URL in the unpublished theme, add several variants and quantities, and use Stripe test card `4242 4242 4242 4242`.

Create a Shopify app in the Dev Dashboard with Admin API scopes `read_products`, `read_inventory`, `write_orders`, release the version, and install it on the real store. If the store is in your own Shopify organization, use the app's Client ID and Client Secret; the server exchanges them for access tokens automatically. Existing legacy admin-created custom apps can instead use their permanent Admin token. Test first against an unpublished duplicate theme. Confirm product status, price, insufficient-stock rejection, one Stripe Session for the cart, webhook retries, and exactly one tagged Shopify order.

## Production

Deploy to a Node-capable host with PostgreSQL and HTTPS. Apply the migration before traffic. Store secrets in the host secret manager, never in `NEXT_PUBLIC_` variables. Register the production Stripe webhook for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.payment_failed`, and `charge.refunded`. Enable database backups, log alerts for HTTP 500 webhooks, and a scheduled reconciliation job that finds `payment_received_order_pending` records and replays `fulfill(session_id)`.

Shopify order creation decrements tracked inventory once; do not adjust inventory separately. Stock is checked before the Stripe Session, but a race remains before payment. If order creation later fails because stock changed, payment remains recorded as `payment_received_order_pending`; staff must restock/create the order or refund in Stripe. Webhook retries do not duplicate orders because Stripe event IDs, Checkout Session IDs, PaymentIntent IDs, and Shopify order IDs are unique and fulfillment holds a PostgreSQL advisory lock.

Refunds made in Stripe are recorded locally by `charge.refunded`. Shopify does not learn of external refunds automatically. The implementation deliberately does not call Shopify's refund mutation because that can initiate a second gateway refund; reconcile the matching Shopify order with a manual no-payment refund workflow or add a separately tested manual transaction mutation for the store's accounting setup.

Shopify discount codes, duties, gift cards, subscriptions, selling plans, and market-specific presentment prices are intentionally not copied. Do not publish the custom button for carts using those features until a server-side Storefront Cart API pricing adapter is added. External Stripe transactions are recorded as gateway `stripe-custom-checkout`, not Shopify Payments; Shopify and Stripe fees/payouts remain separate.

## Security checklist

- [x] Multiple products and quantities create one Stripe Checkout Session
- [x] Prices, currency, product status, and inventory are verified server-side
- [x] Stripe and Shopify secrets are server-only
- [x] Webhook signatures are verified; success redirect is not proof of payment
- [x] Duplicate events and orders are blocked persistently
- [x] Shopify order uses verified variant IDs and quantities
- [ ] Shipping rates verified by merchant in Stripe for US/GB/CA
- [ ] Stripe Tax registrations and inclusive/exclusive behavior verified by merchant
- [x] Inventory is decremented only by Shopify order creation
- [x] Refund synchronization is recorded locally and operational handling is defined
- [x] Failed order creation remains recoverable without another charge
- [ ] Production secrets, HTTPS, alerts, backups, and Stripe webhook configured
