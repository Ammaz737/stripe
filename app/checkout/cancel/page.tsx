export default function Page(){return <main><h1>Payment cancelled</h1><p>No payment was taken.</p><a href={process.env.SHOPIFY_STOREFRONT_ORIGIN+'/cart'}>Return to cart</a></main>}
