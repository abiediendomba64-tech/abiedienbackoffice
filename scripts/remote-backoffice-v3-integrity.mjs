#!/usr/bin/env node
/**
 * Remote integrity smoke test for backoffice-api-v3.
 * No service-role or user secrets are used.
 */
const projectRef=(process.env.SUPABASE_PROJECT_REF||'pnvnpencatzspkwxspac').trim();
const origin=(process.env.INTEGRITY_ORIGIN||'https://abiedienbackoffice.pages.dev').trim();
const base=`https://${projectRef}.supabase.co/functions/v1/backoffice-api-v3`;

function assert(condition,message){if(!condition)throw new Error(message);}

async function request(url,options={}){
  let last;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),8000);
      const response=await fetch(url,{...options,signal:controller.signal});
      clearTimeout(timeout);
      const text=await response.text();
      let json=null;
      try{json=text?JSON.parse(text):null;}catch{}
      if(response.status>=500&&attempt<3){await new Promise(r=>setTimeout(r,500*attempt));continue;}
      return {response,text,json};
    }catch(error){
      last=error;
      if(attempt<3)await new Promise(r=>setTimeout(r,500*attempt));
    }
  }
  throw new Error(`Remote request failed after 3 attempts: ${last?.message||String(last)}`);
}

function requireCors(response){
  assert(response.headers.get('access-control-allow-origin')===origin,
    `CORS origin mismatch: ${response.headers.get('access-control-allow-origin')||'<missing>'}`);
  const h=(response.headers.get('access-control-allow-headers')||'').toLowerCase();
  assert(h.includes('authorization'),'CORS missing authorization');
  assert(h.includes('apikey'),'CORS missing apikey');
}

console.log(`[remote-integrity:v3] project=${projectRef} origin=${origin}`);

const preflight=await request(`${base}/session`,{
  method:'OPTIONS',
  headers:{
    Origin:origin,
    'Access-Control-Request-Method':'GET',
    'Access-Control-Request-Headers':'authorization,content-type,apikey'
  }
});
assert(preflight.response.status===200,`GET preflight expected 200, got ${preflight.response.status}`);
requireCors(preflight.response);

const unauthorized=await request(`${base}/session`,{
  method:'GET',
  headers:{Origin:origin,apikey:'invalid',Authorization:'Bearer invalid'}
});
assert(unauthorized.response.status===401,`/session invalid auth expected 401, got ${unauthorized.response.status}: ${unauthorized.text.slice(0,200)}`);
requireCors(unauthorized.response);
assert(unauthorized.json&&unauthorized.json.error==='unauthorized','/session invalid auth response contract mismatch');

const login=await request(`${base}/login`,{
  method:'POST',
  headers:{Origin:origin,'Content-Type':'application/json',apikey:'invalid',Authorization:'Bearer invalid'},
  body:JSON.stringify({email:'integrity-invalid@example.invalid',password:'not-a-real-password'})
});
assert(login.response.status===401,`/login invalid credentials expected 401, got ${login.response.status}: ${login.text.slice(0,200)}`);
requireCors(login.response);
assert(login.json&&login.json.error==='invalid_credentials','/login invalid credentials contract mismatch');

const refresh=await request(`${base}/refresh`,{
  method:'POST',
  headers:{Origin:origin,'Content-Type':'application/json',apikey:'invalid',Authorization:'Bearer invalid'},
  body:JSON.stringify({refresh_token:'invalid'})
});
assert(refresh.response.status===401,`/refresh invalid token expected 401, got ${refresh.response.status}: ${refresh.text.slice(0,200)}`);
requireCors(refresh.response);
assert(refresh.json&&refresh.json.error==='invalid_refresh_token','/refresh invalid token response contract mismatch');

const legacyPath=await request(`${base}/not-a-real-route`,{
  method:'GET',
  headers:{Origin:origin,apikey:'invalid',Authorization:'Bearer invalid'}
});
assert(legacyPath.response.status===401,`unknown protected route should fail auth first, got ${legacyPath.response.status}`);
requireCors(legacyPath.response);

console.log('[remote-integrity:v3] PASS: preflight, protected auth rejection, public login rejection, refresh rejection, and CORS contracts are healthy.');
