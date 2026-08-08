window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    window.location.replace('{{close_url}}');
  }
}, true);
