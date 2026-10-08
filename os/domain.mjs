export const TIERS={ 'Basic (Legacy)':{price:3.50,solo:0,carousel:1},Basic:{price:5.99,solo:0,carousel:1},Premium:{price:9.99,solo:1,carousel:1},'Premium+':{price:19.99,solo:2,carousel:1}};
export const TYPES=['Basic Club Carousel','Premium Solo','Premium+ Feature 1','Premium+ Feature 2','Editorial','Non-member Feature','Sponsor','Contest','Reel','Other'];
export const STATUSES=['Draft','Waiting for content','Ready','Scheduled','Published','Skipped'];
export const ROUNDS=['Entries','R128','R64','R32','Top 16','Quarter-final','Semi-final','Final','Winner'];
export const DEFAULT_POINTS={'Entries':1,'R128':2,'R64':3,'R32':5,'Top 16':8,'Quarter-final':12,'Semi-final':18,'Final':25,'Winner':40};
export const day=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export const month=(d=new Date())=>day(d).slice(0,7);
export const active=m=>!['CANCELLED','EXPIRED','SUSPENDED','APPROVAL_PENDING','APPROVED','INACTIVE'].includes(m.paypal_status);
export function tier(m){return m.tier==='Basic'&&(m.paypal_plan_id==='P-79Y21508MP396202VMTEPYHI'||(!m.paypal_plan_id&&(m.monthly_price==null||+m.monthly_price===3.5)))?'Basic (Legacy)':m.tier;}
export const price=m=>Number.isFinite(Number(m.monthly_price))&&m.monthly_price!==null?+m.monthly_price:TIERS[tier(m)]?.price||0;
export const mrr=ms=>ms.filter(active).reduce((n,m)=>n+price(m),0);
export function entitlement(m,config=TIERS){const t=config[tier(m)]||{solo:0,carousel:0};return [...(t.carousel?['Basic Club Carousel']:[]),...Array.from({length:t.solo},(_,i)=>tier(m)==='Premium'?'Premium Solo':`Premium+ Feature ${i+1}`)];}
export function fulfilment(m,items,mo,config=TIERS){const required=entitlement(m,config),linked=items.filter(p=>p.date?.startsWith(mo)&&p.member_ids?.includes(String(m.id))&&p.status!=='Skipped');let published=0,scheduled=0;const missing=[];for(const type of required){const p=linked.filter(p=>p.type===type);if(p.some(p=>p.status==='Published'))published++;else if(p.some(p=>['Ready','Scheduled'].includes(p.status)))scheduled++;else missing.push(type);}
return{promised:required.length,published,scheduled,outstanding:required.length-published,unscheduled:missing.length,missing,ratio:required.length?published/required.length:1,linked};}
export function generate(ms,items,mo,config=TIERS,now=new Date()){
 const end=new Date(+mo.slice(0,4),+mo.slice(5,7),0).getDate();const start=mo===month(now)?now.getDate():1;if(mo<month(now))throw Error('Past months are history. Add corrections manually.');let cursor=0;const result=[];
 const date=()=>`${mo}-${String(Math.min(end,start+(cursor++%Math.max(1,end-start+1)))).padStart(2,'0')}`;
 const needs=ms.filter(active).map(m=>({m,types:entitlement(m,config).filter(type=>!items.some(p=>p.date?.startsWith(mo)&&p.status!=='Skipped'&&p.type===type&&p.member_ids?.includes(String(m.id))))}));
 const basic=needs.filter(n=>n.types.includes('Basic Club Carousel'));for(let i=0;i<basic.length;i+=10)result.push({title:`Club collective · ${Math.floor(i/10)+1}`,type:'Basic Club Carousel',date:date(),member_ids:basic.slice(i,i+10).map(n=>String(n.m.id)),status:'Draft',content_ready:false,caption_ready:false});
 for(const {m,types} of needs)for(const type of types.filter(t=>t!=='Basic Club Carousel'))result.push({title:m.handle||'Member feature',type,date:date(),member_ids:[String(m.id)],status:'Draft',content_ready:false,caption_ready:false});return result;
}
export function totals(ms,items,mo,config=TIERS){return ms.filter(active).reduce((s,m)=>{const f=fulfilment(m,items,mo,config);for(const k of ['promised','published','scheduled','outstanding','unscheduled'])s[k]+=f[k];return s;},{promised:0,published:0,scheduled:0,outstanding:0,unscheduled:0});}
export function leaderboard(contests,points=DEFAULT_POINTS){const rows=new Map();for(const c of contests)for(const e of c.entries||[]){const key=e.member_id||e.handle;if(!key)continue;const r=rows.get(key)||{id:key,handle:e.handle,member_id:e.member_id,entered:0,wins:0,podiums:0,points:0};r.entered++;r.points+=Number(points[e.result||'Entries']||0);r.wins+=e.result==='Winner'?1:0;r.podiums+=['Winner','Final','Semi-final'].includes(e.result)?1:0;rows.set(key,r);}return [...rows.values()].sort((a,b)=>b.points-a.points||b.wins-a.wins||String(a.handle).localeCompare(String(b.handle))).map((r,i)=>({...r,rank:i+1}));}
export function scenario(ms,{basicPremium=0,basicPlus=0,newBasic=0,newPremium=0,cancellations=0}={}){const basics=ms.filter(m=>active(m)&&tier(m).startsWith('Basic'));const n=Math.min(basics.length,Math.max(0,basicPremium)),p=Math.min(basics.length-n,Math.max(0,basicPlus));const gain=basics.slice(0,n).reduce((s,m)=>s+9.99-price(m),0)+basics.slice(n,n+p).reduce((s,m)=>s+19.99-price(m),0);const current=mrr(ms),arpm=current/(ms.filter(active).length||1);const delta=gain+Math.max(0,newBasic)*5.99+Math.max(0,newPremium)*9.99-Math.min(ms.filter(active).length,Math.max(0,cancellations))*arpm;return{current,delta,projected:Math.max(0,current+delta),annual:delta*12};}
export function safeURL(s){try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}}
export function csv(rows){return rows.map(row=>row.map(x=>'"'+String(x??'').replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');}

// A deterministic daily rotation: every eligible handle gets a turn before repeating.
export function dailyRound(members,date=day(),count=5){const pool=members.filter(m=>active(m)&&m.handle?.trim()).sort((a,b)=>String(a.id).localeCompare(String(b.id)));if(!pool.length)return[];const offset=((Math.floor(Date.parse(date+'T00:00:00Z')/86400000)*count)%pool.length+pool.length)%pool.length;return Array.from({length:Math.min(count,pool.length)},(_,i)=>pool[(offset+i)%pool.length]);}
export function bracketRounds(entries,winners={}){let slots=Array.from({length:128},(_,i)=>entries[i]||null),rounds=[];for(let r=0;r<7;r++){const matches=[];for(let i=0;i<slots.length;i+=2){const pair=[slots[i],slots[i+1]],key=r+'-'+i/2,winner=pair.every(Boolean)?pair.find(e=>e.key===winners[key])||null:null;matches.push({key,pair,winner});}rounds.push(matches);slots=matches.map(m=>m.winner);}return rounds;}
export function bracketWin(contest,key,entrant){const rounds=bracketRounds(contest.entries,contest.winners),[r,i]=key.split('-').map(Number),match=rounds[r]?.[i];if(!match||!match.pair.every(Boolean)||!match.pair.some(e=>e.key===entrant))throw Error('Both entrants must be decided first.');const winners={...contest.winners,[key]:entrant};for(let next=r+1,index=Math.floor(i/2);next<7;next++,index=Math.floor(index/2))delete winners[next+'-'+index];return winners;}
export function careRound(members,checks,date=day(),count=5,priority=()=>0){const pool=dailyRound(members,date,members.length||1),offset=pool.length?Math.floor(Date.parse(date+'T00:00:00Z')/86400000)%pool.length:0;const rotated=pool.slice(offset).concat(pool.slice(0,offset));const recent=id=>checks.filter(c=>c.member_id===String(id)&&c.completed_at?.slice(0,10)<date).map(c=>c.completed_at).sort().at(-1)||'';return rotated.map((m,i)=>({m,i,last:recent(m.id),score:priority(m)})).sort((a,b)=>{const aRecent=a.last&&Date.parse(date)-Date.parse(a.last)<7*86400000,bRecent=b.last&&Date.parse(date)-Date.parse(b.last)<7*86400000;return Number(!!aRecent)-Number(!!bRecent)||b.score-a.score||a.last.localeCompare(b.last)||a.i-b.i;}).slice(0,count).map(x=>x.m);}

export function dailyProgress(posts,repostMembers,reposts,careMembers,checks,sponsors,today=day()){
 const completedToday=value=>value&&day(new Date(value))===today;
 const publishing=posts.filter(p=>p.date&&p.date<=today&&p.status!=='Skipped'&&(p.date===today||p.status!=='Published'||completedToday(p.published_at)));
 const rounds=repostMembers.map(m=>({...m,done:reposts.some(r=>r.member_id===String(m.id)&&r.round_date===today)}));
 const care=careMembers.map(m=>({...m,done:checks.some(c=>c.member_id===String(m.id)&&c.completed_at?.slice(0,10)===today)}));
 const commitments=sponsors.filter(s=>s.due_date&&s.due_date<=today&&!['Completed','Lost'].includes(s.stage)&&(!s.task_completed_at||completedToday(s.task_completed_at)));
 return {posts:publishing,reposts:rounds,care,sponsors:commitments,total:publishing.length+rounds.length+care.length+commitments.length,done:publishing.filter(p=>p.status==='Published').length+rounds.filter(m=>m.done).length+care.filter(m=>m.done).length+commitments.filter(s=>s.task_completed_at).length};
}
export function generateMonth(members,existing,target,config=TIERS,now=new Date()){
 const result=generate(members,existing,target,config,now),last=new Date(+target.slice(0,4),+target.slice(5,7),0).getDate(),first=target===month(now)?now.getDate():1;
 return result.map((p,i)=>({...p,date:target+'-'+String(first+Math.floor(i*(last-first)/Math.max(1,result.length-1))).padStart(2,'0'),status:'Scheduled'}));
}

export function contestClubEntries(members){const seen=new Set();return members.filter(m=>active(m)&&m.handle?.trim()).flatMap(m=>{const handle=m.handle.trim().replace(/^@/,'');if(seen.has(handle.toLowerCase()))return[];seen.add(handle.toLowerCase());return[{key:crypto.randomUUID(),member_id:String(m.id),handle:'@'+handle,result:'Entries'}];});}
export function contestEntrants(existing,text=''){const entries=existing.map(e=>({...e})),seen=new Set(entries.map(e=>e.handle.replace(/^@/,'').toLowerCase()));for(const value of String(text||'').split(/[\s,]+/).map(h=>h.trim().replace(/^@/,'')).filter(Boolean)){if(!/^[a-zA-Z0-9._]{1,30}$/.test(value))throw Error('Use Instagram handles only: '+value);if(seen.has(value.toLowerCase()))continue;seen.add(value.toLowerCase());entries.push({key:crypto.randomUUID(),handle:'@'+value,result:'Entries'});}return entries;}
export function shuffleContest(entries,random=Math.random){if(entries.length!==128)throw Error('Exactly 128 contestants are required.');const result=entries.map(e=>({...e,key:e.key||crypto.randomUUID()}));for(let i=result.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}

export const CASH_SOURCES=['Membership receipts','Sponsors / advertising','Facebook monetization','Other'];
export function cashSummary(receipts,target){const rows=receipts.filter(r=>r.date?.startsWith(target));const sources=CASH_SOURCES.map(category=>({key:category,label:category,value:rows.filter(r=>r.category===category).reduce((s,r)=>s+Number(r.amount||0),0),detail:'Cash received'}));return{rows,sources,total:sources.reduce((s,r)=>s+r.value,0),facebook:sources[2].value};}
export function lastAttention(memberId,kind,records,posts=[]){const values=kind==='feature'?posts.filter(p=>p.status==='Published'&&p.member_ids?.includes(String(memberId))).map(p=>p.published_at||p.date):records.filter(r=>r.member_id===String(memberId)&&r.completed_at).map(r=>r.completed_at);return values.sort().at(-1)||'';}
export function fairRound(members,records,count=5,kind='repost',posts=[]){const pending=new Set(records.filter(r=>r.round_date&&!r.completed_at).map(r=>r.member_id));return members.filter(m=>active(m)&&m.handle?.trim()&&!pending.has(String(m.id))).sort((a,b)=>lastAttention(a.id,kind,records,posts).localeCompare(lastAttention(b.id,kind,records,posts))||lastAttention(a.id,'feature',[],posts).localeCompare(lastAttention(b.id,'feature',[],posts))||String(a.id).localeCompare(String(b.id))).slice(0,count);}
export function workForDay(posts,reposts,care,sponsors,today=day()){
 const completedToday=v=>v&&day(new Date(v))===today;
 const rows=[...posts.filter(p=>p.status!=='Skipped').map(p=>({...p,kind:'content',due:p.date,done:p.status==='Published',completed:p.published_at})),...reposts.filter(p=>p.round_date).map(p=>({...p,kind:'repost',due:p.due_date||p.round_date,done:!!p.completed_at,completed:p.completed_at})),...care.filter(p=>p.round_date).map(p=>({...p,kind:'care',due:p.due_date||p.round_date,done:!!p.completed_at,completed:p.completed_at})),...sponsors.filter(p=>!['Lost','Completed'].includes(p.stage)).map(p=>({...p,kind:'sponsor',due:p.due_date,done:!!p.task_completed_at,completed:p.task_completed_at}))];
 return rows.filter(p=>p.due&&((!p.done&&p.due<=today)||(p.done&&(p.due===today||completedToday(p.completed))))).sort((a,b)=>a.due.localeCompare(b.due)||a.kind.localeCompare(b.kind));
}

// Earlier counts are reconstructed from subscription intervals, not a full PayPal event log.
export function membershipTrend(members,history=[],now=new Date()){
 const end=now.toISOString().slice(0,10),valid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}/.test(v)&&Number.isFinite(Date.parse(v))&&v.slice(0,10)<=end?v.slice(0,10):null;
 const changes=new Map(),covered=new Set(),unknown=[];
 const add=(date,delta,id,label)=>{if(!changes.has(date))changes.set(date,{date,joined:[],left:[],delta:0});const r=changes.get(date);r.delta+=delta;r[delta>0?'joined':'left'].push({id,label});};
 for(const h of history){covered.add(h.id);const m=members.find(m=>m.paypal_subscription_id===h.id),label=m?.handle||h.id,id=m?.id||null,start=valid(h.started_at),transitions=Array.isArray(h.transitions)&&h.transitions.length?h.transitions:[{status:h.status,at:h.status_changed_at}];
  if(!start){unknown.push(label);continue;}
  // A missing end date cannot be represented as still active for an inactive subscription.
  if(h.status!=='ACTIVE'&&!valid(h.status_changed_at)){unknown.push(label);continue;}
  let state=true;const events=[];let uncertain=false;
  for(const t of transitions){const next=t.status==='ACTIVE';if(next===state)continue;const date=valid(t.at);if(!date||date<start){uncertain=true;break;}events.push({date,delta:next?1:-1});state=next;}
  if(uncertain||state!==(h.status==='ACTIVE')){unknown.push(label);continue;}
  add(start,1,id,label);for(const t of events)add(t.date,t.delta,id,label);
 }
 for(const m of members){if(covered.has(m.paypal_subscription_id))continue;const start=valid(m.join_date_iso);if(!start||!active(m)){unknown.push(m.handle||String(m.id));continue;}add(start,1,m.id,m.handle||String(m.id));}
 let count=0;const points=[...changes.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(r=>({...r,count:(count+=r.delta)}));
 if(points.length){const before=new Date(points[0].date+'T12:00:00Z');before.setUTCDate(before.getUTCDate()-1);points.unshift({date:before.toISOString().slice(0,10),count:0,joined:[],left:[],delta:0,baseline:true});}
 return {points,current:members.filter(active).length,reconstructed:count,unknown,asOf:end,latestSync:history.map(h=>h.synced_at).filter(Boolean).sort().at(-1)||null};
}
