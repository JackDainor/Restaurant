import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
let ready;
const init = () => (ready ||= (async () => {
  await sql`create table if not exists dishes(id serial primary key,name text not null,descr text default '',price numeric(10,2) not null,cat text default 'Platos',img text default '',active boolean default true)`;
  await sql`create table if not exists orders(id serial primary key,name text,phone text,type text,address text default '',pay text,items jsonb,total numeric(10,2),fee numeric(10,2) default 0,status text default 'nuevo',created timestamptz default now())`;
  await sql`create table if not exists settings(k text primary key,v text)`;
})());
const DEF = { name: 'Mi Restaurante', whatsapp: '', fee: '5', min: '30', banner: '', logo: '', open: '1', hours: 'Abierto hoy', delivery: '1', address: '', deliveryText: 'Entrega disponible', categories: 'Platos,Bebidas' };
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
      const addr = b.type === 'local' ? 'Mesa ' + (b.table || '?') : b.address || '';
      const [o] = await sql`insert into orders(name,phone,type,address,pay,items,total,fee) values(${String(b.name).slice(0, 80)},${String(b.phone).slice(0, 30)},${b.type},${String(addr).slice(0, 250)},${String(b.pay || 'pix').slice(0, 20)},${JSON.stringify(items)},${sub + fee},${fee}) returning id,total`;
      return res.json(o);
    }
    if (!admin) return deny();
    if (a === 'login') return res.json({ ok: true });
    if (a === 'orders') return res.json(await sql`select * from orders order by id desc limit 100`);
    if (a === 'history') {
      const start = new Date(String(req.query.start || '')).toISOString();
      const end = new Date(String(req.query.end || '')).toISOString();
      if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return res.status(400).json({ error: 'Mes inválido' });
      return res.json(await sql`select * from orders where created >= ${start}::timestamptz and created < ${end}::timestamptz order by created desc`);
    }
    if (a === 'status') { await sql`update orders set status=${b.status} where id=${+b.id}`; return res.json({ ok: 1 }); }
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
