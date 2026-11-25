const VERSION_URL = new URL('../app-version.json', import.meta.url);

export async function checkDeployment(deploymentId, fetchImpl = fetch) {
  if (typeof deploymentId !== 'string' || !deploymentId) return null;
  const response = await fetchImpl(VERSION_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Version check failed (${response.status}).`);
  const remote = await response.json();
  if (typeof remote?.buildId !== 'string' || !remote.buildId) throw new Error('Deployment version response is invalid.');
  return remote.buildId === deploymentId ? null : remote.buildId;
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (typeof navigator.storage?.persist === 'function') {
    navigator.storage.persist().then(persisted => {
      if (!persisted) console.info('[offline-cache] browser did not grant persistent storage; cached content may be evicted');
    }).catch(error => console.warn('[offline-cache] persistent storage request failed', error));
  }
  return navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { updateViaCache: 'none' });
}

export function startUpdateCheck() {
  let registrationPromise;
  const getRegistration = () => {
    if (!registrationPromise) {
      registrationPromise = registerWorker()?.catch(error => {
        registrationPromise = undefined;
        throw error;
      });
    }
    return registrationPromise;
  };
  let checking = false;
  const check = async () => {
    if (checking || !navigator.onLine) return;
    checking = true;
    try {
      const registration = await getRegistration();
      await registration?.update();
    } catch {
      // Offline and transient update-check errors are retried on reconnect or foreground.
    } finally {
      checking = false;
    }
  };
  void getRegistration()?.catch(() => {});
  void check();
  addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  setInterval(check, 60 * 60 * 1000);
}
