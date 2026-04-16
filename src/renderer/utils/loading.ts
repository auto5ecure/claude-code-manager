// Global loading indicator utility
// Call startLoading('label') / stopLoading() from any component.
// The LoadingIndicator component listens for these events.

let count = 0;

export function startLoading(label = 'Wird geladen...') {
  count++;
  window.dispatchEvent(new CustomEvent('app-loading', { detail: { loading: true, label } }));
  document.querySelector('.app')?.classList.add('app-is-loading');
}

export function stopLoading() {
  count = Math.max(0, count - 1);
  const loading = count > 0;
  window.dispatchEvent(new CustomEvent('app-loading', { detail: { loading } }));
  if (!loading) document.querySelector('.app')?.classList.remove('app-is-loading');
}
