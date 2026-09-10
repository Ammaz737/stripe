import {NextRequest,NextResponse} from 'next/server';
import {db,required} from '@/lib/core';
import {fulfill} from '@/lib/checkout';

export async function POST(request:NextRequest){
  if(request.headers.get('authorization')!==`Bearer ${required('RECOVERY_SECRET')}`)return new NextResponse('Unauthorized',{status:401});
  const pending=await db.query(`SELECT stripe_checkout_session_id FROM checkout_payments WHERE status='payment_received_order_pending' AND stripe_checkout_session_id IS NOT NULL ORDER BY updated_at LIMIT 25`);
  const results=[];
  for(const row of pending.rows){try{await fulfill(row.stripe_checkout_session_id);results.push({sessionId:row.stripe_checkout_session_id,status:'recovered'})}catch(error){results.push({sessionId:row.stripe_checkout_session_id,status:'pending',error:error instanceof Error?error.message:'unknown'})}}
  return NextResponse.json({results});
}
