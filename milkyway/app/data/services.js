const TABLE = 'mw_creator_services';
const FIELDS = 'id,user_id,title,description,price,category,created_at';
const LEGACY_FIELDS = 'id,creator_id,title,description,pricing,category,created_at';
const isLegacySchema = error => /(?:user_id|price).*(?:column|schema cache)|(?:column|schema cache).*(?:user_id|price)/i.test(String(error?.message || ''));
const normalize = row => ({
  ...row,
  user_id: row.user_id || row.creator_id,
  price: row.price ?? row.pricing ?? '',
});
const serviceValues = values => {
  const rawPrice = String(values.price ?? '').trim();
  return {
    title: String(values.title || '').trim(),
    category: String(values.category || '').trim(),
    description: String(values.description || '').trim(),
    price: rawPrice && Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : rawPrice || null,
  };
};
const legacyValues = values => ({
  title: values.title,
  category: values.category,
  description: values.description,
  pricing: String(values.price ?? '').trim(),
});

export async function listCreatorServices(sb, userId, { publicOnly = false } = {}) {
  const current = await sb.from(TABLE).select(FIELDS).eq('user_id', userId).order('created_at', { ascending: false });
  if (!current.error) return (current.data || []).map(row => normalize(row));
  if (!isLegacySchema(current.error)) throw current.error;

  let query = sb.from(TABLE).select(LEGACY_FIELDS).eq('creator_id', userId);
  if (publicOnly) query = query.eq('is_published', true);
  const legacy = await query.order('created_at', { ascending: false });
  if (legacy.error) throw legacy.error;
  return (legacy.data || []).map(normalize);
}

export async function insertCreatorService(sb, userId, input) {
  const values = serviceValues(input);
  const current = await sb.from(TABLE).insert({ ...values, user_id: userId });
  if (!current.error) return;
  if (!isLegacySchema(current.error)) throw current.error;
  const legacy = await sb.from(TABLE).insert({ ...legacyValues(input), creator_id: userId });
  if (legacy.error) throw legacy.error;
}

export async function updateCreatorService(sb, userId, id, input) {
  const values = serviceValues(input);
  const current = await sb.from(TABLE).update(values).eq('id', id).eq('user_id', userId);
  if (!current.error) return;
  if (!isLegacySchema(current.error)) throw current.error;
  const legacy = await sb.from(TABLE).update({
    ...legacyValues(input),
    updated_at: new Date().toISOString(),
  }).eq('id', id).eq('creator_id', userId);
  if (legacy.error) throw legacy.error;
}

export async function deleteCreatorService(sb, userId, id) {
  const current = await sb.from(TABLE).delete().eq('id', id).eq('user_id', userId);
  if (!current.error) return;
  if (!isLegacySchema(current.error)) throw current.error;
  const legacy = await sb.from(TABLE).delete().eq('id', id).eq('creator_id', userId);
  if (legacy.error) throw legacy.error;
}
