const PUBLIC_POST_COLUMNS = [
  'id', 'created_at', 'title', 'category', 'description', 'media_url', 'media_type',
  'title_en', 'title_sw', 'description_en', 'description_sw', 'storage_path', 'published', 'extra_info',
].join(',');

const text = value => {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim();
  if (/^(?:null|undefined)$/i.test(cleaned)) return '';
  return cleaned.replace(/\b(?:null|undefined)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
};

function publicMediaUrl(sb, row) {
  const mediaUrl = text(row.media_url);
  if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;

  let path = text(row.storage_path) || mediaUrl;
  const publicStoragePath = path.match(/\/storage\/v1\/object\/public\/portfolio\/(.+)$/i);
  if (publicStoragePath) path = publicStoragePath[1];
  else if (/^https?:\/\//i.test(path)) return '';
  path = path.replace(/^portfolio\//i, '').replace(/^\/+/, '');
  if (!path) return '';

  const url = sb.storage.from('portfolio').getPublicUrl(path)?.data?.publicUrl;
  return /^https?:\/\//i.test(url || '') ? url : '';
}

export async function loadPublicPosts(sb) {
  const { data, error } = await sb.from('posts')
    .select(PUBLIC_POST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  return (Array.isArray(data) ? data : []).filter(row => row && row.id != null && !/^(?:null|undefined)$/i.test(String(row.id).trim())).map(row => {
    const url = publicMediaUrl(sb, row);
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
