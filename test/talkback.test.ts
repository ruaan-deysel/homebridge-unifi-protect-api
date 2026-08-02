import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { buildTalkbackArgs, isRtpMedia, TALKBACK_BUFFER_LIMIT, TalkbackRelay, talkbackSdp } from '../src/protect/talkback.js'

/**
 * A minimal RTP packet: version 2, payload type 110, and `mark` as its first
 * payload byte so a test can tell one from another. 12 bytes of header is the
 * fixed RTP header, which is what the relay's filter requires.
 */
function rtp(mark: number): Buffer {
  const packet = Buffer.alloc(13)
  packet[0] = 0x80
  packet[1] = 110
  packet[12] = mark
  return packet
}

/**
 * An RTCP packet of the given type — 200 SR, 201 RR, 202 SDES, 203 BYE, 204
 * APP. Masking off the marker bit puts these at 72-76, the range RFC 5761
 * reserves so muxed RTCP can be told apart from RTP.
 */
function rtcp(type: number): Buffer {
  const packet = Buffer.alloc(32)
  packet[0] = 0x80
  packet[1] = type
  return packet
}

function harness(open: () => Promise<number | undefined>) {
  const socket = new EventEmitter() as EventEmitter & { close: () => void }
  socket.close = () => {}
  const forwarded: Array<{ packet: Buffer, port: number }> = []
  const warnings: string[] = []
  const relay = new TalkbackRelay({
    socket: socket as never,
    open,
    forward: (packet, port) => forwarded.push({ packet, port }),
    log: { warn: (m: string) => warnings.push(m) },
  })
  return { socket, forwarded, warnings, relay }
}

describe('talkbackRelay', () => {
  it('does not open until a packet arrives', async () => {
    let calls = 0
    harness(async () => {
      calls++
      return 5000
    })
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  it('opens exactly once for a burst', async () => {
    let calls = 0
    const h = harness(async () => {
      calls++
      return 5000
    })
    for (let i = 0; i < 5; i++) h.socket.emit('message', rtp(i))
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(1)
  })

  it('forwards packets buffered during open, in order', async () => {
    let release: (p: number) => void = () => {}
    const h = harness(() => new Promise<number>((r) => {
      release = r
    }))
    h.socket.emit('message', rtp(1))
    h.socket.emit('message', rtp(2))
    release(5000)
    await new Promise(r => setImmediate(r))
    expect(h.forwarded.map(f => f.packet[12])).toEqual([1, 2])
    expect(h.forwarded.every(f => f.port === 5000)).toBe(true)
  })

  it('drops the oldest past the buffer cap', async () => {
    let release: (p: number) => void = () => {}
    const h = harness(() => new Promise<number>((r) => {
      release = r
    }))
    for (let i = 0; i < TALKBACK_BUFFER_LIMIT + 10; i++) h.socket.emit('message', rtp(i & 0xFF))
    release(5000)
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toHaveLength(TALKBACK_BUFFER_LIMIT)
    expect(h.forwarded[0]?.packet[12]).toBe(10)
  })

  it('forwards nothing when open yields no port', async () => {
    const h = harness(async () => undefined)
    h.socket.emit('message', rtp(1))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toEqual([])
  })

  it('reports a rejected open as a message, never the error object', async () => {
    const h = harness(async () => {
      throw new Error('boom')
    })
    h.socket.emit('message', rtp(1))
    await new Promise(r => setImmediate(r))
    expect(h.warnings.join(' ')).toContain('boom')
    expect(h.forwarded).toEqual([])
  })

  it('forwards nothing after close', async () => {
    const h = harness(async () => 5000)
    h.relay.close()
    h.socket.emit('message', rtp(1))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toEqual([])
  })

  it('stops forwarding once closed, even with a session already open', async () => {
    const h = harness(async () => 5000)
    h.socket.emit('message', rtp(1))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toHaveLength(1)
    h.relay.close()
    h.socket.emit('message', rtp(2))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toHaveLength(1)
  })

  // HAP muxes SRTCP receiver reports onto the return-audio port and sends them
  // on EVERY live view. Opening on one arms the doorbell speaker whenever
  // somebody merely looks — the whole point of opening lazily — and forwarding
  // one feeds ffmpeg's SRTP input a packet that cannot authenticate.
  it('neither opens nor forwards for muxed rtcp', async () => {
    let calls = 0
    const h = harness(async () => {
      calls++
      return 5000
    })
    for (const type of [200, 201, 202, 203, 204])
      h.socket.emit('message', rtcp(type))
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(0)
    expect(h.forwarded).toEqual([])
    // And a real voice packet arriving afterwards still opens the session.
    h.socket.emit('message', rtp(7))
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(1)
    expect(h.forwarded.map(f => f.packet[12])).toEqual([7])
  })
})

describe('isRtpMedia', () => {
  it('accepts a version-2 media packet', () => {
    expect(isRtpMedia(rtp(0))).toBe(true)
    // The marker bit is set on the first packet of a talk burst: payload type
    // 110 becomes 0xEE, and masking it off must still leave 110.
    const marked = rtp(0)
    marked[1] = 0x80 | 110
    expect(isRtpMedia(marked)).toBe(true)
  })

  it('rejects every muxed rtcp type', () => {
    for (const type of [200, 201, 202, 203, 204])
      expect(isRtpMedia(rtcp(type))).toBe(false)
  })

  it('rejects a packet too short to be an rtp header', () => {
    expect(isRtpMedia(rtp(0).subarray(0, 11))).toBe(false)
  })

  it('rejects anything that is not rtp version 2', () => {
    const stray = rtp(0)
    stray[0] = 0x00
    expect(isRtpMedia(stray)).toBe(false)
  })
})

const KEY = Buffer.alloc(30, 7)

describe('talkbackSdp', () => {
  it('describes the inbound srtp stream', () => {
    const sdp = talkbackSdp({ listenPort: 5000, payloadType: 110, key: KEY })
    expect(sdp).toContain('m=audio 5000 RTP/SAVP 110')
    expect(sdp).toContain(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${KEY.toString('base64')}`)
  })

  // RFC 7587 §7: 48000/2 whatever the stream is encoded at. ffmpeg reads the
  // clock rate as the stream's time_base, so a negotiated 16000 would stretch
  // every timestamp by three. The session-level proof — that a 16 kHz
  // negotiation still produces this line — is in test/streaming.test.ts.
  it('always declares the 48 khz opus clock rate', () => {
    const sdp = talkbackSdp({ listenPort: 5000, payloadType: 110, key: KEY })
    expect(sdp.split('\r\n').find(line => line.startsWith('a=rtpmap:'))).toBe('a=rtpmap:110 opus/48000/2')
  })

  it('matches the loopback family to the relay socket', () => {
    const v4 = talkbackSdp({ listenPort: 5000, payloadType: 110, key: KEY })
    expect(v4).toContain('c=IN IP4 127.0.0.1')
    expect(v4).toContain('o=- 0 0 IN IP4 127.0.0.1')
    const v6 = talkbackSdp({ listenPort: 5000, payloadType: 110, key: KEY, ipv6: true })
    expect(v6).toContain('c=IN IP6 ::1')
    expect(v6).toContain('o=- 0 0 IN IP6 ::1')
    expect(v6).not.toContain('127.0.0.1')
  })
})

describe('buildTalkbackArgs', () => {
  it('reads the sdp from stdin and writes to the console destination', () => {
    const args = buildTalkbackArgs({ destination: 'rtp://192.168.10.9:7004', sampleRate: 24000 })
    expect(args).toContain('pipe:0')
    expect(args[args.length - 1]).toBe('rtp://192.168.10.9:7004')
    expect(args).toContain('libopus')
  })

  it('puts every output option before the destination', () => {
    const args = buildTalkbackArgs({ destination: 'rtp://192.168.10.9:7004', sampleRate: 24000 })
    // '-f' appears twice: '-f sdp' (input) and '-f rtp' (output). The output
    // one is the one that must sit between the output options and the
    // destination, so it is the LAST occurrence, not the first.
    const outputFormatFlag = args.lastIndexOf('-f')
    expect(outputFormatFlag).toBeLessThan(args.indexOf('rtp://192.168.10.9:7004'))
    expect(args.indexOf('-c:a')).toBeLessThan(outputFormatFlag)
    expect(args.indexOf('-ar')).toBeLessThan(outputFormatFlag)
    expect(args.indexOf('-ac')).toBeLessThan(outputFormatFlag)
    expect(args.indexOf('-application')).toBeLessThan(outputFormatFlag)
  })

  // The destination is whatever the console answered, and it becomes an ffmpeg
  // OUTPUT url: `-f rtp` does not constrain the protocol and the whitelist is
  // input-side only, so a spoofed console could turn this into a file write.
  it('refuses a destination that is not rtp, without quoting it', () => {
    for (const destination of ['file:///etc/passwd', 'http://evil/x', 'srtp://192.168.10.9:7004', '/tmp/out']) {
      expect(() => buildTalkbackArgs({ destination, sampleRate: 24000 })).toThrow(/not an rtp:\/\/ url/)
      try {
        buildTalkbackArgs({ destination, sampleRate: 24000 })
      }
      catch (error) {
        expect((error as Error).message).not.toContain(destination)
      }
    }
  })

  it('whitelists the protocols the sdp refers to', () => {
    const args = buildTalkbackArgs({ destination: 'rtp://h:1', sampleRate: 24000 })
    const list = args[args.indexOf('-protocol_whitelist') + 1] ?? ''
    for (const p of ['pipe', 'udp', 'rtp', 'srtp'])
      expect(list.split(',')).toContain(p)
  })
})
