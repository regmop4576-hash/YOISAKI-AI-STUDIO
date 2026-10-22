import {NextRequest,NextResponse} from 'next/server';import {equals,sessionValue,digest} from '@/lib/connect/security';import {db,init} from '@/lib/connect/db';
export async function POST(req:NextRequest){
  if(!process.env.OWNER_PASSWORD||process.env.OWNER_PASSWORD.length<16||!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)return NextResponse.json({error:'Server owner login is not configured'},{status:503});
  try{
    await init();const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';const key=digest(ip);
    const existing=await db().query('SELECT attempts,blocked_until FROM login_attempts WHERE key=$1',[key]);
    if(existing.rowCount&&existing.rows[0].attempts>=5&&new Date(existing.rows[0].blocked_until).getTime()>Date.now())return NextResponse.json({error:'Too many attempts. Try later.'},{status:429});
    const password=(await req.json().catch(()=>({}))).password;
    if(typeof password!=='string'||!equals(password,process.env.OWNER_PASSWORD)){
      await db().query(`INSERT INTO login_attempts(key,attempts,blocked_until) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.blocked_until<now() THEN 1 ELSE login_attempts.attempts+1 END,blocked_until=now()+interval '15 minutes'`,[key]);return NextResponse.json({error:'Invalid password'},{status:401});
    }
    await db().query('DELETE FROM login_attempts WHERE key=$1',[key]);const res=NextResponse.json({ok:true});res.cookies.set('yoisaki_owner',sessionValue(),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:86400});return res;
  }catch(e){console.error('Login storage unavailable',e);return NextResponse.json({error:'Login storage unavailable'},{status:503})}
}
export async function DELETE(){const r=NextResponse.json({ok:true});r.cookies.delete('yoisaki_owner');return r;}
