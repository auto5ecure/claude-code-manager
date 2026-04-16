import { useState, useEffect } from 'react';

export default function LoadingIndicator() {
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState('Wird geladen...');

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { loading: boolean; label?: string };
      setVisible(detail.loading);
      if (detail.label) setLabel(detail.label);
    };
    window.addEventListener('app-loading', handler);
    return () => window.removeEventListener('app-loading', handler);
  }, []);

  if (!visible) return null;

  return (
    <div className="global-loading-container">
      <div className="global-loading-pill">
        <div className="global-loading-spinner">
          <div className="gls-ring" />
          <span className="gls-mc">MC</span>
        </div>
        <span className="global-loading-label">{label}</span>
      </div>
    </div>
  );
}
