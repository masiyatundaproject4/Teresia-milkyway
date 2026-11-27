const PUBLIC_POST_COLUMNS = [
  'id', 'created_at', 'title', 'category', 'description', 'media_url', 'media_type',
  'title_en', 'title_sw', 'description_en', 'description_sw', 'storage_path', 'published',
];
const PUBLIC_POST_REQUIRED_COLUMNS = ['id'];
const PUBLIC_POST_OPTIONAL_COLUMNS = [
  ...PUBLIC_POST_COLUMNS.filter(column => !PUBLIC_POST_REQUIRED_COLUMNS.includes(column)),
  'extra_info',
];
const PUBLIC_POST_PAGE_SIZE = 500;

const text = value => {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  if (/^(?:null|undefined)$/i.test(cleaned)) return '';
  return cleaned.replace(/\b(?:null|undefined)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
};

export function portfolioMediaUrl(sb, row) {
  const mediaUrl = text(row.media_url);
  if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;

  let path = text(row.storage_path) || mediaUrl;
  if (/^https?:\/\//i.test(path)) return path;
  const publicStoragePath = path.match(/\/storage\/v1\/object\/(?:public|sign)\/portfolio\/(.+)$/i);
  if (publicStoragePath) path = publicStoragePath[1];
  path = path.replace(/^\/?storage\/v1\/object\/(?:public|sign)\/portfolio\//i, '')
    .replace(/^\/?portfolio\//i, '').replace(/^\/+/, '').split(/[?#]/, 1)[0];
  if (!path) return '';

  const url = sb.storage.from('portfolio').getPublicUrl(path)?.data?.publicUrl;
  return /^https?:\/\//i.test(url || '') ? url : '';
}

export async function loadPublicPosts(sb) {
  let fields = [...PUBLIC_POST_OPTIONAL_COLUMNS];
  const data = [];
  let offset = 0;
  while (true) {
    const columns = [...PUBLIC_POST_REQUIRED_COLUMNS, ...fields].join(',');
    let query = sb.from('posts').select(columns);
    query = query.order(fields.includes('created_at') ? 'created_at' : 'id', { ascending: false });
    const result = await query.range(offset, offset + PUBLIC_POST_PAGE_SIZE - 1);
    if (!result.error) {
      const page = Array.isArray(result.data) ? result.data : [];
      data.push(...page);
      if (page.length < PUBLIC_POST_PAGE_SIZE) break;
      offset += PUBLIC_POST_PAGE_SIZE;
      continue;
    }
    const missingOptional = fields.find(column => {
      const message = String(result.error?.message || '');
      return /schema cache|column .* does not exist|could not find the .*column/i.test(message)
        && new RegExp(`\\b${column}\\b`, 'i').test(message);
    });
    if (!missingOptional) throw result.error;
    fields = fields.filter(column => column !== missingOptional);
  }

  return (Array.isArray(data) ? data : []).filter(row => row && row.id != null && !/^(?:null|undefined)$/i.test(String(row.id).trim())).map(row => {
    const url = portfolioMediaUrl(sb, row);
    const mediaType = text(row.media_type) || (/\.(mp4|m4v|mov|webm|ogv|3gp)(\?|#|$)/i.test(url) ? 'video' : url ? 'image' : '');
    const swahili = typeof document !== 'undefined' && document.documentElement.lang === 'sw';
    const title = (swahili ? text(row.title_sw) || text(row.title_en) : text(row.title_en) || text(row.title_sw)) || text(row.title);
    const description = (swahili ? text(row.description_sw) || text(row.description_en) : text(row.description_en) || text(row.description_sw)) || text(row.description);
    return {
      ...row,
      id: `public:${String(row.id)}`,
      public_post_id: String(row.id),
      public_post: true,
      author_id: '',
      author_name: 'MilkyWay',
      author: { id: '', name: 'MilkyWay', username: '', avatar: '' },
      audience: 'everyone',
      title,
      description,
      caption: [title, description].filter(Boolean).join('\n'),
      media_url: url,
      media_type: mediaType,
      media: url ? { url, type: mediaType || 'image' } : null,
      createdAt: row.created_at || '',
    };
  });
}
