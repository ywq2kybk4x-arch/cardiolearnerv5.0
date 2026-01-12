(() => {
  if (document.getElementById('license-footer')) {
    return;
  }

  const year = new Date().getFullYear();
  const projectName = 'Interactive Cardiac Physiology Simulator';
  const authors = 'Kevin Surace, Yashas Basavarajappa, Avi Belbase, Hussein Elfayoumy';
  const footerAttribution = 'Interactive Cardiac Physiology Simulator Team';
  const licenseUrl = 'https://creativecommons.org/licenses/by-nc-nd/4.0/';

  const footer = document.createElement('footer');
  footer.id = 'license-footer';
  footer.className = 'license-footer';
  footer.innerHTML = `
    <div class="license-footer-inner">
      <span>© ${year} ${projectName} — ${footerAttribution} •</span>
      <a href="${licenseUrl}" target="_blank" rel="noopener">CC BY-NC-ND 4.0</a>
      <button type="button" class="license-credits-link" data-license-credits>License &amp; Credits</button>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.className = 'license-modal-overlay';
  overlay.id = 'license-modal-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="license-modal" role="dialog" aria-modal="true" aria-labelledby="license-modal-title">
      <button type="button" class="license-modal-close" aria-label="Close license and credits">×</button>
      <h2 id="license-modal-title">License &amp; Credits</h2>
      <p><strong>${projectName}</strong></p>
      <p><strong>Authors:</strong> ${authors}</p>
      <p>You may share this work for non-commercial purposes with attribution and no derivatives.</p>
      <p><a href="${licenseUrl}" target="_blank" rel="noopener">https://creativecommons.org/licenses/by-nc-nd/4.0/</a></p>
    </div>
  `;

  document.body.appendChild(footer);
  document.body.appendChild(overlay);

  const creditsButton = footer.querySelector('[data-license-credits]');
  const closeButton = overlay.querySelector('.license-modal-close');
  let lastFocused = null;

  const openModal = () => {
    lastFocused = document.activeElement;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    closeButton.focus();
    document.addEventListener('keydown', handleKeydown);
  };

  const closeModal = () => {
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', handleKeydown);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
  };

  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
    }
  };

  creditsButton.addEventListener('click', openModal);
  closeButton.addEventListener('click', closeModal);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeModal();
    }
  });

  const applyTheme = () => {
    const style = window.getComputedStyle(document.body);
    const color = style.backgroundColor;
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) {
      return;
    }
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const root = document.documentElement;

    if (luminance > 0.6) {
      root.style.setProperty('--license-footer-bg', 'rgba(255, 255, 255, 0.88)');
      root.style.setProperty('--license-footer-text', '#1f2937');
      root.style.setProperty('--license-footer-border', 'rgba(15, 23, 42, 0.12)');
      root.style.setProperty('--license-modal-bg', '#ffffff');
      root.style.setProperty('--license-modal-text', '#0f172a');
      root.style.setProperty('--license-modal-muted', '#475569');
    } else {
      root.style.setProperty('--license-footer-bg', 'rgba(8, 10, 16, 0.72)');
      root.style.setProperty('--license-footer-text', '#f8fafc');
      root.style.setProperty('--license-footer-border', 'rgba(148, 163, 184, 0.2)');
      root.style.setProperty('--license-modal-bg', '#0b1020');
      root.style.setProperty('--license-modal-text', '#f8fafc');
      root.style.setProperty('--license-modal-muted', '#cbd5f5');
    }
  };

  applyTheme();
})();
