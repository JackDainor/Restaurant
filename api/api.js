import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
let ready;
const init = () => (ready ||= (async () => {
  await sql`create table if not exists dishes(id serial primary key,name text not null,descr text default '',price numeric(10,2) not null,cat text default 'Platos',img text default '',active boolean default true)`;
  await sql`create table if not exists orders(id serial primary key,name text,phone text,type text,address text default '',pay text,items jsonb,total numeric(10,2),fee numeric(10,2) default 0,status text default 'nuevo',created timestamptz default now())`;
  await sql`create table if not exists settings(k text primary key,v text)`;
  await sql`create table if not exists promotions(id serial primary key,code text unique not null,title text default '',kind text not null,value numeric(10,2) not null,min_total numeric(10,2) default 0,starts_at timestamptz,ends_at timestamptz,active boolean default true,created timestamptz default now())`;
  await sql`alter table orders add column if not exists promo_code text default ''`;
  await sql`alter table orders add column if not exists discount numeric(10,2) default 0`;
  await sql`alter table orders add column if not exists updated_at timestamptz default now()`;
  await sql`alter table orders add column if not exists courier_id integer`;
  await sql`alter table orders add column if not exists courier_fee numeric(10,2) default 0`;
  await sql`alter table orders add column if not exists courier_paid boolean default false`;
  await sql`alter table orders add column if not exists delivery_lat numeric(10,7)`;
  await sql`alter table orders add column if not exists delivery_lng numeric(10,7)`;
  await sql`create table if not exists couriers(id serial primary key,name text not null,phone text not null,vehicle text default 'Moto',plate text default '',active boolean default true,created timestamptz default now())`;
})());
const DEF = { name: 'Mi Restaurante', whatsapp: '', fee: '5', min: '30', banner: '', logo: '', pix_key: '', pix_qr: '', open: '1', hours: 'Abierto hoy', delivery: '1', address: '', deliveryText: 'Entrega disponible', categories: 'Platos,Bebidas' };
const settings = async () => {
  const r = await sql`select k,v from settings`;
  return { ...DEF, ...Object.fromEntries(r.map(x => [x.k, x.v])) };
};
export default async function handler(req, res) {
  try {
    await init();
    const a = req.query.a, b = req.body || {};
    const admin = !!process.env.ADMIN_PASSWORD && req.headers['x-admin'] === process.env.ADMIN_PASSWORD;
    const deny = () => res.status(401).json({ error: 'No autorizado' });
    if (a === 'myorders') {
      const phone = String(req.query.phone || '').replace(/\\D/g, '');
      if (phone.length < 8) return res.status(400).json({error:'WhatsApp inválido'});
      const rows = await sql`select id,status,created,updated_at,type,total,items from orders where regexp_replace(phone,'[^0-9]','','g')=${phone} order by created desc limit 50`;
      return res.json(rows);
    }
    if (a === 'track') {
      const id = Number(req.query.id), phone = String(req.query.phone || '').replace(/\\D/g, '');
      if (!Number.isInteger(id) || id < 1 || phone.length < 8) return res.status(400).json({error:'Número de pedido o WhatsApp inválido'});
      const [o] = await sql`select o.id,o.status,o.created,o.updated_at,o.type,o.total,o.items,c.name as courier_name,c.phone as courier_phone from orders o left join couriers c on c.id=o.courier_id where o.id=${id} and regexp_replace(o.phone,'[^0-9]','','g')=${phone} limit 1`;
      if (!o) return res.status(404).json({error:'No encontramos ese pedido con ese WhatsApp'});
      return res.json(o);
    }
    if (a === 'menu') {
      const dishes = admin ? await sql`select * from dishes order by cat,id` : await sql`select * from dishes where active order by cat,id`;
      return res.json({ dishes, s: await settings() });
    }
    if (a === 'order' && req.method === 'POST') {
      const s = await settings();
      if (s.open !== '1') return res.status(400).json({ error: 'El restaurante está cerrado' });
      if (!b.name || !b.phone || !Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Faltan datos' });
      if (!['pix', 'debito', 'credito'].includes(b.pay)) return res.status(400).json({ error: 'Método de pago inválido' });
      if (!['local', 'recoger', 'delivery'].includes(b.type)) return res.status(400).json({ error: 'Tipo inválido' });
      if (b.type === 'delivery' && s.delivery === '0') return res.status(400).json({ error: 'El delivery no está disponible' });
      if (b.type === 'delivery' && !b.address) return res.status(400).json({ error: 'Falta la dirección' });
      const ids = b.items.map(i => +i.id);
      const rows = await sql`select id,name,price from dishes where active and id = any(${ids})`;
      const items = [];
      let sub = 0;
      for (const i of b.items) {
        const d = rows.find(r => r.id === +i.id), q = Math.min(Math.max(+i.q | 0, 1), 50);
        if (!d) continue;
        items.push({ id: d.id, name: d.name, price: +d.price, q });
        sub += +d.price * q;
      }
      if (!items.length) return res.status(400).json({ error: 'Pedido vacío' });
      if (sub < +s.min) return res.status(400).json({ error: `Pedido mínimo R$ ${s.min}` });
      const fee = b.type === 'delivery' ? +s.fee : 0;
      let discount = 0, promoCode = '';
      if (b.promoCode) {
        const code = String(b.promoCode).trim().toUpperCase();
        const [promo] = await sql`select code,kind,value,min_total from promotions where upper(code)=${code} and active=true and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>=now()) limit 1`;
        if (!promo) return res.status(400).json({error:'La promoción ya no está disponible'});
        if (sub < Number(promo.min_total || 0)) return res.status(400).json({error:`Compra mínima: R$ ${promo.min_total}`});
        discount = Math.min(sub, promo.kind === 'percent' ? sub * Number(promo.value) / 100 : Number(promo.value));
        discount = Math.round(discount * 100) / 100;
        promoCode = promo.code;
      }
      const addr = b.type === 'local' ? 'Mesa ' + (b.table || '?') : b.address || '';
      const [o] = await sql`insert into orders(name,phone,type,address,pay,items,total,fee,promo_code,discount,delivery_lat,delivery_lng) values(${String(b.name).slice(0, 80)},${String(b.phone).slice(0, 30)},${b.type},${String(addr).slice(0, 250)},${String(b.pay || 'pix').slice(0, 20)},${JSON.stringify(items)},${sub - discount + fee},${fee},${promoCode},${discount},${b.type==='delivery'&&b.lat!==null&&b.lat!==undefined&&Number.isFinite(Number(b.lat))?Number(b.lat):null},${b.type==='delivery'&&b.lng!==null&&b.lng!==undefined&&Number.isFinite(Number(b.lng))?Number(b.lng):null}) returning id,total,discount,promo_code`;
      return res.json(o);
    }
    if (a === 'checkpromo' && req.method === 'POST') {
      const code = String(b.code || '').trim().toUpperCase();
      const [p] = await sql`select code,title,kind,value,min_total from promotions where upper(code)=${code} and active=true and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>=now()) limit 1`;
      if (!p) return res.status(400).json({error:'Código promocional inválido o vencido'});
      const subtotal = Math.max(0, Number(b.subtotal) || 0);
      if (subtotal < Number(p.min_total || 0)) return res.status(400).json({error:`Compra mínima: R$ ${p.min_total}`});
      const discount = Math.min(subtotal, p.kind === 'percent' ? subtotal * Number(p.value) / 100 : Number(p.value));
      return res.json({ok:1,code:p.code,title:p.title,discount});
    }
    if (!admin) return deny();
    if (a === 'login') return res.json({ ok: true });
    if (a === 'orders') return res.json(await sql`select o.*,c.name as courier_name,c.phone as courier_phone from orders o left join couriers c on c.id=o.courier_id order by o.id desc limit 300`);
    if (a === 'couriers') return res.json(await sql`select * from couriers order by active desc,name`);
    if (a === 'courier' && req.method === 'POST') {
      const name=String(b.name||'').trim().slice(0,80), phone=String(b.phone||'').trim().slice(0,30);
      if(!name||phone.replace(/\\D/g,'').length<8) return res.status(400).json({error:'Nombre y teléfono válido son obligatorios'});
      if(b.id) await sql`update couriers set name=${name},phone=${phone},vehicle=${String(b.vehicle||'Moto').slice(0,30)},plate=${String(b.plate||'').slice(0,20)},active=${b.active!==false} where id=${+b.id}`;
      else await sql`insert into couriers(name,phone,vehicle,plate) values(${name},${phone},${String(b.vehicle||'Moto').slice(0,30)},${String(b.plate||'').slice(0,20)})`;
      return res.json({ok:1});
    }
    if (a === 'assigncourier' && req.method === 'POST') {
      const id=Number(b.id), courierId=Number(b.courier_id), payout=Math.max(0,Number(b.courier_fee)||0);
      if(!Number.isInteger(id)||!Number.isInteger(courierId)||payout>10000) return res.status(400).json({error:'Datos de asignación inválidos'});
      const [courier]=await sql`select id from couriers where id=${courierId} and active=true`;
      if(!courier) return res.status(400).json({error:'Motoboy no disponible'});
      const rows=await sql`update orders set courier_id=${courierId},courier_fee=${payout},courier_paid=false,status='en camino',updated_at=now() where id=${id} and type='delivery' returning id`;
      if(!rows.length) return res.status(404).json({error:'Pedido delivery no encontrado'});
      return res.json({ok:1});
    }
    if (a === 'courierpaid' && req.method === 'POST') {
      const rows=await sql`update orders set courier_paid=${!!b.paid},updated_at=now() where id=${+b.id} and courier_id is not null returning id,courier_paid`;
      if(!rows.length)return res.status(404).json({error:'Pedido o motoboy no encontrado'});
      return res.json({ok:1,order:rows[0]});
    }
    if (a === 'history') {
      const startDate = new Date(String(req.query.start || ''));
      const endDate = new Date(String(req.query.end || ''));
      if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) return res.status(400).json({ error: 'Mes inválido' });
      const start = startDate.toISOString();
      const end = endDate.toISOString();
      return res.json(await sql`select * from orders where created >= ${start}::timestamptz and created < ${end}::timestamptz order by created desc`);
    }
    if (a === 'status') {
      const allowed = ['nuevo','confirmado','preparando','listo','en camino','entregado','cancelado'];
      if (!Number.isInteger(+b.id) || +b.id < 1 || !allowed.includes(b.status)) return res.status(400).json({ error: 'Estado o pedido inválido' });
      const rows = await sql`update orders set status=${b.status},updated_at=now() where id=${+b.id} returning id,status,updated_at`;
      if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.json({ ok: 1, order: rows[0] });
    }
    if (a === 'promotions' && req.method === 'GET') return res.json(await sql`select * from promotions order by created desc`);
    if (a === 'promotion' && req.method === 'POST') {
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32);
      const title = String(b.title || '').trim().slice(0,100);
      const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
      const value = Number(b.value), min = Math.max(0, Number(b.min_total) || 0);
      if (!code || !title || !Number.isFinite(value) || value <= 0 || (kind === 'percent' && value > 100)) return res.status(400).json({error:'Revisa el código, nombre y valor del descuento'});
      const start = b.starts_at ? new Date(b.starts_at) : null, end = b.ends_at ? new Date(b.ends_at) : null;
      if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime())) || (start && end && end <= start)) return res.status(400).json({error:'Fechas de promoción inválidas'});
      if (b.id) {
        await sql`update promotions set code=${code},title=${title},kind=${kind},value=${value},min_total=${min},starts_at=${start ? start.toISOString() : null},ends_at=${end ? end.toISOString() : null},active=${b.active !== false} where id=${+b.id}`;
      } else {
        await sql`insert into promotions(code,title,kind,value,min_total,starts_at,ends_at,active) values(${code},${title},${kind},${value},${min},${start ? start.toISOString() : null},${end ? end.toISOString() : null},${b.active !== false})`;
      }
      return res.json({ok:1});
    }
    if (a === 'delpromotion') { await sql`delete from promotions where id=${+b.id}`; return res.json({ok:1}); }
    if (a === 'dish') {
      const p = +b.price || 0;
      if (b.id) await sql`update dishes set name=${b.name},descr=${b.descr || ''},price=${p},cat=${b.cat || 'Platos'},img=${b.img || ''},active=${b.active !== false} where id=${+b.id}`;
      else await sql`insert into dishes(name,descr,price,cat,img,active) values(${b.name},${b.descr || ''},${p},${b.cat || 'Platos'},${b.img || ''},${b.active !== false})`;
      return res.json({ ok: 1 });
    }
    if (a === 'deldish') { await sql`delete from dishes where id=${+b.id}`; return res.json({ ok: 1 }); }
    if (a === 'settings') {
      for (const k of Object.keys(DEF)) if (k in b) await sql`insert into settings(k,v) values(${k},${String(b[k])}) on conflict(k) do update set v=excluded.v`;
      return res.json({ ok: 1 });
    }
    res.status(404).json({ error: 'No existe' });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
