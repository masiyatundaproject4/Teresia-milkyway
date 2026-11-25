// Paint the MilkyWay galaxy mark before app modules run, then release the shell as soon as the DOM is ready.
(() => {
  const splash = document.getElementById('mwSplash');
  if (!splash) return;
  let done = false;
  const hide = () => {
    if (done) return;
    done = true;
    splash.remove();
    window.dispatchEvent(new Event('mw-splash-hidden'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide, { once: true });
  else requestAnimationFrame(hide);
})();
