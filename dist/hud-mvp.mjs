const panels = new WeakMap();

export function paintRoundMvp(panel, mvp, eventId) {
  let nodes = panels.get(panel);
  if (!mvp) {
    if (nodes) nodes.row.hidden = true;
    return;
  }

  if (!nodes) {
    const document = panel.ownerDocument;
    const row = document.createElement('div');
    const label = document.createElement('b');
    const name = document.createElement('span');
    const detail = document.createElement('span');
    row.className = 'round-mvp';
    label.className = 'round-mvp-label';
    label.textContent = 'MVP';
    name.className = 'round-mvp-name';
    detail.className = 'round-mvp-detail';
    row.append(label, name, detail);
    panel.append(row);
    nodes = { row, name, detail, eventId: null };
    panels.set(panel, nodes);
  }

  const stats = [
    mvp.roundKills == null ? null : `${mvp.roundKills} фраг.`,
    mvp.roundDamage == null ? null : `${mvp.roundDamage} урона`,
  ].filter(Boolean).join(' · ');
  if (nodes.name.textContent !== mvp.name) nodes.name.textContent = mvp.name;
  if (nodes.detail.textContent !== stats) nodes.detail.textContent = stats;
  nodes.detail.hidden = !stats;
  nodes.row.hidden = false;
  if (eventId !== nodes.eventId) {
    nodes.eventId = eventId;
    nodes.row.getAnimations().forEach(animation => animation.cancel());
    if (!panel.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      nodes.row.animate([{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], {
        duration: 210,
        easing: 'cubic-bezier(.16, 1, .3, 1)',
      });
    }
  }
}
