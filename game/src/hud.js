import { FRAMES_TO_WIN } from '@snooker/sim';

const $ = (id) => document.getElementById(id);

const BALL_ON_LABEL = {
  red: 'on: red',
  colour: 'on: any colour',
};

export class Hud {
  constructor() {
    this.el = {
      nameA: $('name-a'), nameB: $('name-b'),
      avatarA: $('avatar-a'), avatarB: $('avatar-b'),
      playerA: $('player-a'), playerB: $('player-b'),
      scoreA: $('score-a'), scoreB: $('score-b'),
      framesA: $('frames-a'), framesB: $('frames-b'),
      clock: $('clock'), ballOn: $('ballon'), breakLine: $('breakline'),
      toast: $('toast'), hint: $('hint'), shoot: $('shoot'), concede: $('concede'),
      power: $('power'), powerFill: $('power-fill'), powerLabel: $('power-label'),
      overlay: $('overlay'), overlayTitle: $('overlay-title'),
      overlayBody: $('overlay-body'), overlayActions: $('overlay-actions'),
      syncBadge: $('sync-badge'), syncCount: $('sync-count'),
    };
    this.toastTimer = null;
  }

  setPlayers(a, b) {
    this.el.nameA.textContent = a.name;
    this.el.nameB.textContent = b.name;
    this.el.avatarA.textContent = a.name.slice(0, 2).toUpperCase();
    this.el.avatarB.textContent = b.name.slice(0, 2).toUpperCase();
    if (a.photo) this.el.avatarA.innerHTML = `<img src="${a.photo}" alt="">`;
    if (b.photo) this.el.avatarB.innerHTML = `<img src="${b.photo}" alt="">`;
  }

  setFrame(frame, framesWon = [0, 0]) {
    this.el.scoreA.textContent = frame.scores[0];
    this.el.scoreB.textContent = frame.scores[1];
    this.el.playerA.classList.toggle('active', frame.turn === 0);
    this.el.playerB.classList.toggle('active', frame.turn === 1);

    const pips = (won) => '●'.repeat(won) + '○'.repeat(Math.max(0, FRAMES_TO_WIN - won));
    this.el.framesA.textContent = pips(framesWon[0]);
    this.el.framesB.textContent = pips(framesWon[1]);

    this.el.ballOn.textContent = BALL_ON_LABEL[frame.ballOn] ?? `on: ${frame.ballOn}`;
    this.el.breakLine.textContent = frame.currentBreak > 0
      ? `break ${frame.currentBreak}`
      : `frame ${frame.frame}`;
  }

  setClock(seconds) {
    const el = this.el.clock;
    if (seconds === null || seconds === undefined) {
      el.textContent = '--';
      el.className = 'clock';
      return;
    }
    const s = Math.max(0, Math.ceil(seconds));
    el.textContent = String(s).padStart(2, '0');
    el.className = `clock${s <= 5 ? ' danger' : s <= 10 ? ' warn' : ''}`;
  }

  setPower(power) {
    this.el.powerFill.style.height = `${Math.round(power * 100)}%`;
    this.el.powerLabel.textContent = `${Math.round(power * 100)}%`;
    this.el.power.setAttribute('aria-valuenow', Math.round(power * 100));
  }

  setShootEnabled(enabled) {
    this.el.shoot.disabled = !enabled;
  }

  /** Show or hide the mid-frame Concede button. The handler is set by the Game. */
  setConcede(visible) {
    this.el.concede.hidden = !visible;
  }

  onConcede(handler) {
    this.el.concede.onclick = handler;
  }

  hint(text) {
    this.el.hint.textContent = text ?? '';
  }

  toast(text, kind = '', ms = 2600) {
    const el = this.el.toast;
    el.textContent = text;
    el.className = kind;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  setPending(count) {
    this.el.syncBadge.hidden = count === 0;
    this.el.syncCount.textContent = count;
  }

  /** @param {{title:string, body:string, actions:Array<{label:string,kind?:string,onClick:Function}>}} opts */
  modal({ title, body, actions = [] }) {
    this.el.overlayTitle.textContent = title;
    this.el.overlayBody.innerHTML = body;
    this.el.overlayActions.innerHTML = '';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = `btn ${action.kind ?? ''}`;
      btn.textContent = action.label;
      btn.onclick = () => action.onClick();
      this.el.overlayActions.appendChild(btn);
    }
    this.el.overlay.hidden = false;
  }

  closeModal() {
    this.el.overlay.hidden = true;
  }
}

export const describeOutcome = (outcome, youAreStriker) => {
  if (outcome.foul) {
    const reasons = {
      miss: 'Miss',
      'wrong-ball-first': 'Wrong ball first',
      'cue-ball-potted': 'In-off',
      'ball-off-table': 'Ball off the table',
      'wrong-ball-potted': 'Wrong ball potted',
      'multiple-colours-potted': 'Two colours potted',
      'shot-clock-expired': 'Shot clock ran out',
    };
    const label = reasons[outcome.foulReasons?.[0]] ?? 'Foul';
    return {
      text: `${label} — ${outcome.penalty} to ${youAreStriker ? 'your opponent' : 'you'}`,
      kind: 'foul',
    };
  }
  if (outcome.pointsScored > 0) {
    return {
      text: `+${outcome.pointsScored}${outcome.breakValue > outcome.pointsScored ? ` · break ${outcome.breakValue}` : ''}`,
      kind: 'good',
    };
  }
  return { text: 'No score — turn passes', kind: '' };
};
