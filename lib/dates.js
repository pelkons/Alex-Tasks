'use strict';
// Jerusalem wall-clock time to a UTC ISO string
function jerusalemToISO(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const part = (ms) => {
    const o = {};
    for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) o[p.type] = +p.value;
    return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute);
  };
  const off = part(guess) - guess;
  return new Date(guess - off).toISOString();
}
module.exports = { jerusalemToISO };
