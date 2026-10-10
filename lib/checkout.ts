import "server-only";
import crypto from "node:crypto";
import Decimal from "decimal.js";
import Stripe from "stripe";
import { gid, gql, minor, required, stripe, tx } from "./core";
export type Item = { variantId: string; quantity: number };
export type MarketContext = { countryCode: string; currency: string };
type Variant = {
  id: string;
  title: string;
  price: string;
  contextualPricing?: { price: { amount: string; currencyCode: string } };
  inventoryQuantity: number | null;
  inventoryPolicy: "CONTINUE" | "DENY";
  inventoryItem: { tracked: boolean };
  image: { url: string } | null;
  product: { title: string; status: string };
};
const VARIANTS = `query Variants($ids:[ID!]!){shop{currencyCode}nodes(ids:$ids){... on ProductVariant{id title price inventoryQuantity inventoryPolicy inventoryItem{tracked}image{url}product{title status}}}}`;
const MARKET_VARIANTS = `query Variants($ids:[ID!]!,$country:CountryCode!){shop{currencyCode}nodes(ids:$ids){... on ProductVariant{id title price contextualPricing(context:{country:$country}){price{amount currencyCode}} inventoryQuantity inventoryPolicy inventoryItem{tracked}image{url}product{title status}}}}`;
const ORDER = `mutation Create($order:OrderCreateOrderInput!){orderCreate(order:$order){order{id name}userErrors{field message}}}`;
export async function createCheckout(items: Item[], cartToken: string, market?: MarketContext) {
  const data = await gql<{
    shop: { currencyCode: string };
    nodes: (Variant | null)[];
  }>(market ? MARKET_VARIANTS : VARIANTS, { ids: items.map((x) => gid(x.variantId)), ...(market ? { country: market.countryCode } : {}) });
  const currency = market?.currency || data.shop.currencyCode;
  const map = new Map(data.nodes.filter(Boolean).map((v) => [v!.id, v!]));
  const verified = items.map((i) => {
    const v = map.get(gid(i.variantId));
    if (!v || v.product.status !== "ACTIVE")
      throw new Error(`Variant ${i.variantId} is unavailable`);
    const price = market ? v.contextualPricing?.price : { amount: v.price, currencyCode: currency };
    if (!price || price.currencyCode !== currency)
      throw new Error("Market currency changed. Refresh the store and try again.");
    if (
      v.inventoryItem.tracked &&
      v.inventoryPolicy === "DENY" &&
      (v.inventoryQuantity ?? 0) < i.quantity
    )
      throw new Error(`${v.product.title} has insufficient stock`);
    return {
      variantId: v.id,
      quantity: i.quantity,
      name:
        v.title === "Default Title"
          ? v.product.title
          : `${v.product.title} — ${v.title}`,
      unitAmount: minor(price.amount, currency),
      image: v.image?.url,
    };
  });
  const taxBehavior = (process.env.STRIPE_TAX_BEHAVIOR ||
    "exclusive") as Stripe.Checkout.SessionCreateParams.LineItem.PriceData.TaxBehavior;
  let allowedCountries = required("SHIPPING_ALLOWED_COUNTRIES").split(
    ",",
  ) as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[];
  // UAE is an active, shipping-enabled Shopify market. Keep its AED session
  // restricted to UAE so changing shipping country cannot retain another price.
  if (market?.countryCode === "AE" && currency === "AED") allowedCountries = ["AE"];
  else if (market) {
    if (!allowedCountries.includes(market.countryCode as typeof allowedCountries[number]))
      throw new Error("Shipping is unavailable for the selected country.");
    allowedCountries = [market.countryCode as typeof allowedCountries[number]];
  }
  const shippingOptions: Stripe.Checkout.SessionCreateParams.ShippingOption[] = [{
    shipping_rate_data: {
      type: "fixed_amount",
      fixed_amount: { amount: 0, currency: currency.toLowerCase() },
      display_name: "Free Shipping",
      delivery_estimate: {
        minimum: { unit: "business_day", value: 5 },
        maximum: { unit: "business_day", value: 10 },
      },
    },
  }];
  const canonical = JSON.stringify({
    cartToken,
    verified,
    currency,
    market,
    taxBehavior,
    allowedCountries,
    shippingOptions,
    phoneCollection: true,
    bucket: Math.floor(Date.now() / 1800000),
  });
  const attempt = crypto.createHash("sha256").update(canonical).digest("hex");
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [attempt]);
    const old = await c.query(
      "SELECT stripe_checkout_session_id FROM checkout_payments WHERE attempt_key=$1",
      [attempt],
    );
    if (old.rowCount && old.rows[0].stripe_checkout_session_id) {
      const s = await stripe().checkout.sessions.retrieve(
        old.rows[0].stripe_checkout_session_id,
      );
      if (s.url && s.status === "open") return s.url;
    }
    const id = crypto.randomUUID();
    await c.query(
      `INSERT INTO checkout_payments(id,attempt_key,status,currency,items) VALUES($1,$2,'creating',$3,$4) ON CONFLICT(attempt_key) DO UPDATE SET updated_at=now()`,
      [id, attempt, currency, JSON.stringify(verified)],
    );
    const s = await stripe().checkout.sessions.create(
      {
        mode: "payment",
        adaptive_pricing: { enabled: false },
        line_items: verified.map((x) => ({
          quantity: x.quantity,
          price_data: {
            currency: currency.toLowerCase(),
            unit_amount: x.unitAmount,
            tax_behavior: taxBehavior,
            product_data: {
              name: x.name,
              images: x.image ? [x.image] : undefined,
              metadata: { shopify_variant_id: x.variantId },
            },
          },
        })),
        automatic_tax: { enabled: true },
        shipping_address_collection: {
          allowed_countries: allowedCountries,
        },
        shipping_options: shippingOptions,
        billing_address_collection: "required",
        customer_creation: "always",
        phone_number_collection: { enabled: true },
        success_url: `${required("NEXT_PUBLIC_SITE_URL")}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${required("NEXT_PUBLIC_SITE_URL")}/checkout/cancel`,
        metadata: {
          checkout_id: id,
          shopify_cart_token: cartToken.slice(0, 200),
          ...(market ? { market_country: market.countryCode, presentment_currency: currency } : {}),
        },
      },
      { idempotencyKey: attempt },
    );
    await c.query(
      `UPDATE checkout_payments SET stripe_checkout_session_id=$1,status='checkout_created',updated_at=now() WHERE attempt_key=$2`,
      [s.id, attempt],
    );
    if (!s.url) throw new Error("Stripe returned no Checkout URL");
    console.info("checkout_created", { checkoutId: id, sessionId: s.id });
    return s.url;
  });
}
export async function fulfill(sessionId: string) {
  const s = await stripe().checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent", "shipping_cost.shipping_rate"],
  });
  if (s.payment_status !== "paid") return;
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [s.id]);
    const p = await c.query(
      "SELECT * FROM checkout_payments WHERE stripe_checkout_session_id=$1 FOR UPDATE",
      [s.id],
    );
    if (!p.rowCount) throw new Error("Unknown checkout");
    if (p.rows[0].shopify_order_id) return;
    const pi =
      typeof s.payment_intent === "string"
        ? s.payment_intent
        : s.payment_intent?.id;
    await c.query(
      `UPDATE checkout_payments SET stripe_payment_intent_id=$1,status='payment_received_order_pending',amount=$2,customer_email=$3,updated_at=now() WHERE id=$4`,
      [pi, s.amount_total, s.customer_details?.email, p.rows[0].id],
    );
    const shippingDetails = s.collected_information?.shipping_details;
    const a = shippingDetails?.address || s.customer_details?.address;
    const customerName =
      shippingDetails?.name || s.customer_details?.name || "";
    const shippingAmount = s.shipping_cost?.amount_total || 0;
    const shippingRate = s.shipping_cost?.shipping_rate;
    const shippingTitle =
      typeof shippingRate === "object" && shippingRate?.display_name
        ? shippingRate.display_name
        : "Shipping";
    const order = {
      email: s.customer_details?.email,
      currency: s.currency?.toUpperCase(),
      presentmentCurrency: s.currency?.toUpperCase(),
      financialStatus: "PAID",
      tags: ["stripe-custom-checkout"],
      note: `Stripe Checkout ${s.id}; PaymentIntent ${pi}`,
      lineItems: p.rows[0].items.map((x: any) => ({
        variantId: x.variantId,
        quantity: x.quantity,
        priceSet: { shopMoney: { amount: new Decimal(x.unitAmount).div(100).toFixed(2), currencyCode: s.currency?.toUpperCase() }, presentmentMoney: { amount: new Decimal(x.unitAmount).div(100).toFixed(2), currencyCode: s.currency?.toUpperCase() } },
      })),
      shippingAddress: a
        ? {
            firstName: customerName.split(" ")[0],
            lastName: customerName.split(" ").slice(1).join(" "),
            address1: a.line1,
            address2: a.line2,
            city: a.city,
            province: a.state,
            countryCode: a.country,
            zip: a.postal_code,
            phone: s.customer_details?.phone || undefined,
          }
        : undefined,
      shippingLines:
        shippingAmount > 0
          ? [
              {
                title: shippingTitle,
                code:
                  typeof shippingRate === "string"
                    ? shippingRate
                    : shippingRate?.id,
                source: "stripe",
                priceSet: {
                  shopMoney: {
                    amount: new Decimal(shippingAmount).div(100).toFixed(2),
                    currencyCode: s.currency?.toUpperCase(),
                  },
                },
              },
            ]
          : undefined,
      test: !s.livemode,
      transactions: [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "stripe-custom-checkout",
          amountSet: {
            shopMoney: {
              amount: new Decimal(s.amount_total || 0).div(100).toFixed(2),
              currencyCode: s.currency?.toUpperCase(),
            },
          },
          authorizationCode: pi,
          receiptJson: JSON.stringify({ stripe_checkout_session_id: s.id }),
          test: !s.livemode,
        },
      ],
    };
    const out = await gql<any>(ORDER, { order });
    const errs = out.orderCreate.userErrors;
    if (errs.length) throw new Error(JSON.stringify(errs));
    await c.query(
      `UPDATE checkout_payments SET shopify_order_id=$1,status='order_created',updated_at=now() WHERE id=$2`,
      [out.orderCreate.order.id, p.rows[0].id],
    );
    console.info("shopify_order_created", {
      sessionId: s.id,
      orderId: out.orderCreate.order.id,
    });
  });
}
