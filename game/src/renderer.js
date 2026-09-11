import {
  TABLE, BALL_RADIUS, POCKETS, BAULK_LINE_X, D_RADIUS, CENTRE_Y, COLOURS,
} from '@snooker/sim';

const BALL_COLOURS = {
  cue: '#f4f1e6',
  red: '#c8202a',
  yellow: '#e8c53a',
  green: '#1c7a45',
  brown: '#7a4a24',
  blue: '#1f5fbf',
  pink: '#e58bb0',
  black: '#141414',
};

const RAIL = 9;        // cm of visible rail drawn outside the playing surface
const CLOTH = '#0f6b48';
const CLOTH_EDGE = '#0b5137';
const WOOD = '#4a2f1c';

export class TableRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  }

  /** Fit the table into the available box, keeping the 2:1 aspect ratio. */
  resize(maxW, maxH) {
    const worldW = TABLE.width + RAIL * 2;
    const worldH = TABLE.height + RAIL * 2;
    this.scale = Math.max(0.1, Math.min(maxW / worldW, maxH / worldH));
    const cssW = Math.floor(worldW * this.scale);
    const cssH = Math.floor(worldH * this.scale);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
  }

  /** Canvas pixel -> table centimetres. */
  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / this.scale - RAIL,
      y: (clientY - rect.top) / this.scale - RAIL,
    };
  }

  #begin() {
    const { ctx } = this;
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, 0, 0);
    ctx.translate(RAIL, RAIL);
  }

  #drawTable() {
    const { ctx } = this;
    // Rails.
    ctx.fillStyle = WOOD;
    ctx.beginPath();
    ctx.roundRect(-RAIL, -RAIL, TABLE.width + RAIL * 2, TABLE.height + RAIL * 2, 4);
    ctx.fill();

    // Cloth.
    ctx.fillStyle = CLOTH;
    ctx.fillRect(0, 0, TABLE.width, TABLE.height);
    ctx.strokeStyle = CLOTH_EDGE;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(0, 0, TABLE.width, TABLE.height);

    // Baulk line and the D.
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(BAULK_LINE_X, 0);
    ctx.lineTo(BAULK_LINE_X, TABLE.height);
    ctx.stroke();
    // The D sits on the baulk side of the line, bulging toward x = 0. Sweeping
    // the other way mirrors it onto the black-end side, which is not where the
    // cue ball is actually allowed to go (see inTheD() in controls.js).
    ctx.beginPath();
    ctx.arc(BAULK_LINE_X, CENTRE_Y, D_RADIUS, Math.PI / 2, -Math.PI / 2, false);
    ctx.stroke();

    // Spots.
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    for (const c of COLOURS) {
      ctx.beginPath();
      ctx.arc(c.spot.x, c.spot.y, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pockets.
    for (const p of POCKETS) {
      const grad = ctx.createRadialGradient(p.x, p.y, 0.5, p.x, p.y, p.r);
      grad.addColorStop(0, '#000');
      grad.addColorStop(1, '#0b0f0d');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #drawBall(ball, { highlight = false, dim = false } = {}) {
    const { ctx } = this;
    const fill = BALL_COLOURS[ball.color] ?? '#999';

    ctx.save();
    if (dim) ctx.globalAlpha = 0.35;

    ctx.beginPath();
    ctx.arc(ball.x, ball.y + 0.6, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fill();

    const grad = ctx.createRadialGradient(
      ball.x - BALL_RADIUS * 0.35, ball.y - BALL_RADIUS * 0.4, BALL_RADIUS * 0.15,
      ball.x, ball.y, BALL_RADIUS,
    );
    grad.addColorStop(0, '#ffffff88');
    grad.addColorStop(0.35, fill);
    grad.addColorStop(1, '#00000055');

    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.fillStyle = grad;
    ctx.fill();

    if (highlight) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.6;
      ctx.setLineDash([1.6, 1.6]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, BALL_RADIUS + 1.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  #drawAim(cue, angle, power) {
    const { ctx } = this;
    const len = 40 + power * 90;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 2.5]);
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(cue.x + Math.cos(angle) * len, cue.y + Math.sin(angle) * len);
    ctx.stroke();
    ctx.setLineDash([]);

    // Ghost cue ball at the end of the aim line.
    const gx = cue.x + Math.cos(angle) * len;
    const gy = cue.y + Math.sin(angle) * len;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.arc(gx, gy, BALL_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    // Cue stick behind the ball, pulled back with power.
    const back = 8 + power * 22;
    ctx.strokeStyle = '#d8b076';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cue.x - Math.cos(angle) * back, cue.y - Math.sin(angle) * back);
    ctx.lineTo(cue.x - Math.cos(angle) * (back + 110), cue.y - Math.sin(angle) * (back + 110));
    ctx.stroke();
    ctx.restore();
  }

  #drawDZone() {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(53,196,138,.16)';
    ctx.beginPath();
    ctx.arc(BAULK_LINE_X, CENTRE_Y, D_RADIUS, Math.PI / 2, -Math.PI / 2, false);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * @param {object} view
   * @param {Array}  view.balls
   * @param {string} view.ballOn      'red' | 'colour' | a colour id
   * @param {object} [view.aim]       {angle, power} while aiming
   * @param {boolean} [view.showD]    highlight the D for in-hand placement
   */
  draw(view) {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.#begin();
    this.#drawTable();
    if (view.showD) this.#drawDZone();

    const onTable = view.balls.filter((b) => !b.potted);
    const cue = onTable.find((b) => b.id === 'cue');

    for (const ball of onTable) {
      if (ball.id === 'cue') continue;
      const isOn = view.ballOn === 'red'
        ? ball.color === 'red'
        : (view.ballOn === 'colour' ? ball.color !== 'red' : ball.id === view.ballOn);
      this.#drawBall(ball, { highlight: isOn && view.highlightOn !== false });
    }

    if (cue) {
      if (view.aim) this.#drawAim(cue, view.aim.angle, view.aim.power);
      this.#drawBall(cue);
    }
  }
}
