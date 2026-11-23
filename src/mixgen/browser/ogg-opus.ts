/**
 * Minimal Ogg Opus muxer (RFC 7845 / RFC 3533) for WebCodecs `AudioEncoder` output.
 * Produces a standard .opus file playable by every modern browser's <audio>.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    t[i] = r >>> 0
  }
  return t
})()

export function oggCrc(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0
  return crc >>> 0
}

export class OggOpusMuxer {
  private readonly serial = (Math.random() * 0xffffffff) >>> 0
  private seq = 0
  private readonly parts: Uint8Array[] = []
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private granule = 0
  readonly preSkip: number

  constructor(
    readonly channels: number,
    readonly inputRate: number,
    preSkip = 312,
  ) {
    this.preSkip = preSkip
    const head = new Uint8Array(19)
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]) // "OpusHead"
    const v = new DataView(head.buffer)
    head[8] = 1
    head[9] = channels
    v.setUint16(10, preSkip, true)
    v.setUint32(12, inputRate, true)
    v.setInt16(16, 0, true)
    head[18] = 0
    this.page([head], 0, 0x02)
    const vendor = new TextEncoder().encode('CrowdPilot')
    const tags = new Uint8Array(8 + 4 + vendor.length + 4)
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]) // "OpusTags"
    const tv = new DataView(tags.buffer)
    tv.setUint32(8, vendor.length, true)
    tags.set(vendor, 12)
    tv.setUint32(12 + vendor.length, 0, true)
    this.page([tags], 0, 0)
    this.granule = preSkip
  }

  private page(packets: Uint8Array[], granule: number, flags: number): void {
    const lacing: number[] = []
    for (const p of packets) {
      let n = p.length
      while (n >= 255) {
        lacing.push(255)
        n -= 255
      }
      lacing.push(n)
    }
    const bodyLen = packets.reduce((a, p) => a + p.length, 0)
    const page = new Uint8Array(27 + lacing.length + bodyLen)
    const v = new DataView(page.buffer)
    page.set([0x4f, 0x67, 0x67, 0x53]) // "OggS"
    page[4] = 0
    page[5] = flags
    v.setUint32(6, granule % 0x100000000, true)
    v.setUint32(10, Math.floor(granule / 0x100000000), true)
    v.setUint32(14, this.serial, true)
    v.setUint32(18, this.seq++, true)
    v.setUint32(22, 0, true)
    page[26] = lacing.length
    page.set(lacing, 27)
    let o = 27 + lacing.length
    for (const p of packets) {
      page.set(p, o)
      o += p.length
    }
    v.setUint32(22, oggCrc(page), true)
    this.parts.push(page)
  }

  /** Add one Opus packet covering `samples48k` samples at 48 kHz. */
  addPacket(packet: Uint8Array, samples48k: number): void {
    this.pending.push(packet)
    this.pendingBytes += packet.length
    this.granule += samples48k
    // ≤ 255 lacing values per page; flush around 4 KB (≈ 50 packets at 192 kbps)
    if (this.pending.length >= 50 || this.pendingBytes > 4000) this.flush(false)
  }

  private flush(eos: boolean, finalGranule?: number): void {
    if (!this.pending.length && !eos) return
    this.page(this.pending, finalGranule ?? this.granule, eos ? 0x04 : 0)
    this.pending = []
    this.pendingBytes = 0
  }

  /** Finish the stream; `totalInputSamples48k` trims the encoder's end padding. */
  finish(totalInputSamples48k: number): Blob {
    this.flush(true, this.preSkip + totalInputSamples48k)
    return new Blob(this.parts as BlobPart[], { type: 'audio/ogg; codecs=opus' })
  }
}
