const CANONICAL_HOST = 'www.masiyatunda.com';
const NON_CANONICAL_HOSTS = new Set([
  'masiyatunda.com',
  'milkyway-project.pages.dev',
]);

export function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (!NON_CANONICAL_HOSTS.has(url.hostname.toLowerCase())) return next();
  url.hostname = CANONICAL_HOST;
  return Response.redirect(url, 308);
}
