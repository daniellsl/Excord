/* Minimal JSZip-compatible writer for MV3 service workers.
 * Supports zip.file(path, Blob|ArrayBuffer|Uint8Array|string) and generateAsync({ type: "blob" }).
 * Entries are stored without compression to avoid remote dependencies while still creating valid ZIP files.
 */
(function attachJSZip(globalScope) {
  const encoder = new TextEncoder();
  const crcTable = makeCrcTable();

  class JSZipLite {
    constructor(prefix = "", entries = []) {
      this.prefix = prefix;
      this.entries = entries;
    }

    folder(name) {
      const clean = normalizePath(`${this.prefix}${name}/`);
      return new JSZipLite(clean, this.entries);
    }

    file(name, content) {
      this.entries.push({ name: normalizePath(`${this.prefix}${name}`), content });
      return this;
    }

    async generateAsync(options = {}, onUpdate) {
      const chunks = [];
      const central = [];
      let offset = 0;

      for (let index = 0; index < this.entries.length; index += 1) {
        const entry = this.entries[index];
        const data = await toUint8Array(entry.content);
        const name = encoder.encode(entry.name);
        const crc = crc32(data);
        const local = new Uint8Array(30 + name.length);
        const localView = new DataView(local.buffer);
        writeLocalHeader(localView, name, crc, data.length);
        local.set(name, 30);
        chunks.push(local, data);

        const centralHeader = new Uint8Array(46 + name.length);
        const centralView = new DataView(centralHeader.buffer);
        writeCentralHeader(centralView, name, crc, data.length, offset);
        centralHeader.set(name, 46);
        central.push(centralHeader);
        offset += local.length + data.length;
        if (onUpdate) onUpdate({ percent: ((index + 1) / this.entries.length) * 100, currentFile: entry.name });
      }

      const centralSize = central.reduce((sum, item) => sum + item.length, 0);
      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true);
      endView.setUint16(8, this.entries.length, true);
      endView.setUint16(10, this.entries.length, true);
      endView.setUint32(12, centralSize, true);
      endView.setUint32(16, offset, true);

      const blob = new Blob([...chunks, ...central, end], { type: "application/zip" });
      if (options.type === "uint8array") return new Uint8Array(await blob.arrayBuffer());
      return blob;
    }
  }

  function writeLocalHeader(view, name, crc, size) {
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, name.length, true);
  }

  function writeCentralHeader(view, name, crc, size, offset) {
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, name.length, true);
    view.setUint16(36, 0, true);
    view.setUint32(42, offset, true);
  }

  async function toUint8Array(content) {
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
    return encoder.encode(String(content ?? ""));
  }

  function normalizePath(path) {
    return String(path).replace(/^\/+/, "").replace(/\/+/g, "/");
  }

  function makeCrcTable() {
    return Array.from({ length: 256 }, (_, index) => {
      let c = index;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }

  function crc32(data) {
    let crc = -1;
    for (let index = 0; index < data.length; index += 1) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ data[index]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }

  globalScope.JSZip = JSZipLite;
})(globalThis);
