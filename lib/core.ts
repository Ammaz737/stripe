import 'server-only';
import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import Stripe from 'stripe';
import {Pool,PoolClient} from 'pg';

export const stripe=new Stripe(required('STRIPE_SECRET_KEY'));
export const db=new Pool({connectionString:required('DATABASE_URL'),max:10});
export function required(k:string){const v=process.env[k];if(!v)throw new Error(`Missing ${k}`);return v}
const zero=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']);
const three=new Set(['BHD','JOD','KWD','OMR','TND']);
export function minor(v:string,c:string){const n=new Decimal(v).mul(new Decimal(10).pow(zero.has(c)?0:three.has(c)?3:2));if(!n.isInteger()||n.lte(0)||n.gt(Number.MAX_SAFE_INTEGER))throw new Error(`Invalid ${c} amount`);return n.toNumber()}
export function gid(id:string){return id.startsWith('gid://')?id:`gid://shopify/ProductVariant/${id}`}
let shopifyToken:{value:string;expiresAt:number}|undefined;
let shopifyTokenRequest:Promise<string>|undefined;
async function accessToken(){
  const legacy=process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if(legacy)return legacy;
  if(shopifyToken&&Date.now()<shopifyToken.expiresAt)return shopifyToken.value;
  if(shopifyTokenRequest)return shopifyTokenRequest;
  shopifyTokenRequest=(async()=>{
    const shop=required('SHOPIFY_STORE_DOMAIN');
    const body=new URLSearchParams({grant_type:'client_credentials',client_id:required('SHOPIFY_CLIENT_ID'),client_secret:required('SHOPIFY_CLIENT_SECRET')});
    const r=await fetch(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,cache:'no-store'});
    const j=await r.json() as {access_token?:string;expires_in?:number;error?:string;error_description?:string};
    if(!r.ok||!j.access_token)throw new Error(`Shopify OAuth: ${j.error_description||j.error||r.status}`);
    shopifyToken={value:j.access_token,expiresAt:Date.now()+Math.max(60,(j.expires_in||86399)-300)*1000};
    return j.access_token;
  })().finally(()=>{shopifyTokenRequest=undefined});
  return shopifyTokenRequest;
}
export async function gql<T>(query:string,variables:object):Promise<T>{const r=await fetch(`https://${required('SHOPIFY_STORE_DOMAIN')}/admin/api/${required('SHOPIFY_API_VERSION')}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':await accessToken()},body:JSON.stringify({query,variables}),cache:'no-store'});const j=await r.json();if(!r.ok||j.errors)throw new Error(`Shopify Admin API: ${JSON.stringify(j.errors||r.status)}`);return j.data}
export async function rateLimit(ip:string){const key=crypto.createHash('sha256').update(ip).digest('hex');const r=await db.query(`INSERT INTO api_rate_limits(key,bucket,count) VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(key,bucket) DO UPDATE SET count=api_rate_limits.count+1 RETURNING count`,[key]);if(r.rows[0].count>20)throw new Error('RATE_LIMIT')}
export async function tx<T>(fn:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');const x=await fn(c);await c.query('COMMIT');return x}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
