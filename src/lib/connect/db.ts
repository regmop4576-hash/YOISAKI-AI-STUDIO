import {Pool,PoolClient} from 'pg';
let pool:Pool|undefined;let initialized:Promise<void>|undefined;
export function db(){if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is not configured');return pool??(pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,ssl:process.env.DATABASE_URL?.includes('localhost')?false:undefined}));}
export async function init(){if(!initialized)initialized=(async()=>{await db().query(`
CREATE TABLE IF NOT EXISTS engines(id UUID PRIMARY KEY,owner TEXT NOT NULL DEFAULT 'owner',credential_hash TEXT NOT NULL,provider TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now(), revoked BOOLEAN DEFAULT false, last_heartbeat TIMESTAMPTZ, state TEXT DEFAULT 'OFFLINE',telemetry JSONB DEFAULT '{}', models JSONB DEFAULT '[]', refresh_requested BOOLEAN DEFAULT false);
CREATE TABLE IF NOT EXISTS pairing(id UUID PRIMARY KEY,owner TEXT NOT NULL DEFAULT 'owner',code_hash TEXT NOT NULL UNIQUE,expires_at TIMESTAMPTZ NOT NULL,used BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS jobs(id UUID PRIMARY KEY,owner TEXT NOT NULL DEFAULT 'owner',engine_id UUID NOT NULL REFERENCES engines(id),kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'QUEUED',request JSONB NOT NULL,progress JSONB DEFAULT '{}',result JSONB,error TEXT,lease_until TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS result_uploads(job_id UUID NOT NULL REFERENCES jobs(id), idx INT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(job_id,idx));
CREATE TABLE IF NOT EXISTS lora_metadata(owner TEXT NOT NULL, model_id TEXT NOT NULL, model_kind TEXT NOT NULL DEFAULT 'lora', trigger_words JSONB NOT NULL DEFAULT '[]', recommended_tags JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(owner,model_id,model_kind));
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, attempts INT NOT NULL, blocked_until TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(engine_id,status,created_at);
`);})();try{await initialized}catch(e){initialized=undefined;throw e}}
export async function transaction<T>(cb:(c:PoolClient)=>Promise<T>):Promise<T>{await init();const c=await db().connect();try{await c.query('BEGIN');const result=await cb(c);await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
