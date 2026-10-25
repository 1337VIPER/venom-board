// Playtest feedback forms: says straight away when a screenshot is too big to send, and shows the form is sending.
// The form works without this script; the server checks everything again.
(() => {
  const form = document.querySelector('.fb-form');
  if (!form) return;
  const file = form.querySelector('input[type=file]'), button = form.querySelector('button[type=submit]');
  const label = button.textContent, MAX = 5 * 1024 * 1024;
  let shown = null;
  const say = msg => {
    if (!msg) { if (shown) { shown.remove(); shown = null; } return; }
    if (!shown) { shown = document.createElement('p'); shown.className = 'fb-err'; shown.setAttribute('role', 'alert'); form.prepend(shown); }
    shown.textContent = msg;
  };
  const check = () => {
    const f = file && file.files && file.files[0];
    if (f && f.size > MAX) return 'That screenshot is bigger than 5 MB. Pick a smaller one, or crop it.';
    if (f && !/^image\/(png|jpeg|webp)$/.test(f.type)) return 'The screenshot has to be a PNG, JPEG or WebP picture.';
    return '';
  };
  if (file) file.addEventListener('change', () => say(check()));
  form.addEventListener('submit', e => {
    const problem = check();
    if (problem) { e.preventDefault(); say(problem); return; }
    button.disabled = true; button.textContent = 'Sending…';
  });
  // coming back to the page (the browser's back button) finds the button ready again
  window.addEventListener('pageshow', () => { button.disabled = false; button.textContent = label; });
})();
