import {NextRequest,NextResponse} from 'next/server';import {cookies} from 'next/headers';import {db,init} from './db';import {digest,equals,validSession} from './security';
export async function owner(){return validSession((await cookies()).get('yoisaki_owner')?.value)}
export async function worker(req:NextRequest){const t=req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];if(!t)return null;await init();const r=await db().query('SELECT id,owner FROM engines WHERE credential_hash=$1 AND revoked=false',[digest(t)]);return r.rows[0] as {id:string;owner:string}|undefined||null}
export const denied=()=>NextResponse.json({error:'Unauthorized'},{status:401});
export const error=(e:unknown)=>{console.error('[connect]',e);return NextResponse.json({error:'Service unavailable or invalid request'},{status:503})};
