// owner 2026-07-26 ⑦ —「二维码要能看到且能扫」("the QR code must be visible and scannable").
//
// Visibility is a template concern (PairingModal renders the img whenever the
// payload exists and shouts when rendering fails). SCANNABILITY is provable
// headlessly: render the exact production payload with the exact production
// library + options, then DECODE the pixels back with an independent decoder
// (jsqr — a different implementation, so a qrcode-encoder bug cannot vouch for
// itself). What the phone's camera would read must equal what addByCode parses.

import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { buildQrPayload, derivePairingModal } from './pairing';

/** Render `text` the way PairingModal does, but to raw RGBA for the decoder. */
async function renderToRgba(text: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  // Same content/EC level as production; raw pixel access instead of a data URL
  // because vitest's node env has no <canvas> to rasterize a PNG back out of.
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = 8;
  const px = size * scale;
  const rgba = new Uint8ClampedArray(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const dark = qr.modules.get(Math.floor(x / scale), Math.floor(y / scale));
      const v = dark ? 0 : 255;
      const i = (y * px + x) * 4;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  return { data: rgba, width: px, height: px };
}

describe('pairing QR round-trip (encode → independent decode)', () => {
  it('the LAN payload survives the trip verbatim', async () => {
    const payload = buildQrPayload({ endpoint: 'http://192.168.1.20:41879', code: '4821' });
    const img = await renderToRgba(payload);
    const decoded = jsQR(img.data, img.width, img.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe('flowmic://pair?endpoint=ws://192.168.1.20:41879&code=4821&channel=standalone');
  });

  it('the CLOUD payload (GA-31: the saas arm nothing ever exercised) too', async () => {
    const payload = buildQrPayload({ endpoint: 'https://flowmic.app', code: '9007', channel: 'saas' });
    const img = await renderToRgba(payload);
    const decoded = jsQR(img.data, img.width, img.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe('flowmic://pair?endpoint=wss://flowmic.app&code=9007&channel=saas');
  });

  it('0.2.66: the CLOUD payload with a `pcid=` survives the trip verbatim', async () => {
    // The whole point of scanning on this channel now: the phone forwards the link
    // BYTE FOR BYTE as `qr_payload`, and the relay pulls the pcid back out of it
    // (server-core `room/registry.ts`, symbol `resolvePcForPair`). A decoder that
    // gave back anything but this exact string would make the QR path fail with
    // PAIR_PCID_UNKNOWN — 「扫上了，但配不上」("scanned fine, but couldn't pair"), the worst shape a QR can have.
    const payload = buildQrPayload({
      endpoint: 'https://flowmic.app',
      code: '9007',
      channel: 'saas',
      pcid: '302914775',
    });
    expect(payload).toBe('flowmic://pair?endpoint=wss://flowmic.app&code=9007&channel=saas&pcid=302914775');
    const img = await renderToRgba(payload);
    const decoded = jsQR(img.data, img.width, img.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(payload);
    // …and the code the server would read out of the DECODED pixels is still the
    // 4-digit one, not a slice of the nine-digit id sitting behind it.
    expect(/code=(\d{4})/.exec(decoded!.data)?.[1]).toBe('9007');
  });

  it('B4-15: a payload carrying every LAN address still decodes verbatim', async () => {
    // The whole reason `alt=` is capped: it makes the picture denser. This is the
    // measurement behind that cap — the WORST case the desktop can emit (a full
    // QR_ALT_MAX list of 15-char addresses) must still come back byte-for-byte
    // through an independent decoder, or the phone gets a code it cannot read.
    const payload = buildQrPayload({
      endpoint: 'http://10.0.0.178:41879',
      code: '4821',
      candidates: [
        '10.0.0.178',
        '100.64.7.178',
        '10.211.55.100',
        '192.168.137.200',
        '172.30.240.111',
        '169.200.100.250',
      ],
    });
    // Six candidates, one of which is the endpoint's own ⇒ QR_ALT_MAX=5 alternates.
    expect(payload.split('alt=')[1]!.split(',')).toHaveLength(5);
    const img = await renderToRgba(payload);
    const decoded = jsQR(img.data, img.width, img.height);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(payload);
  });

  it('what the modal actually shows for a connected LAN snapshot is that same payload', () => {
    // Ties the round-trip above to the REAL modal path: derivePairingModal must
    // hand the template the exact payload the tests just proved scannable.
    const view = derivePairingModal({
      short_code: '4821',
      endpoint: 'http://192.168.1.20:41879',
      pc_name: 'PC',
      connected: true,
      mobiles: 0,
    });
    expect(view.qrSuppressed).toBe(false);
    expect(view.qrPayload).toBe('flowmic://pair?endpoint=ws://192.168.1.20:41879&code=4821&channel=standalone');
  });
});
