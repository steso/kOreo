// kOreo web app — local TWIX parsing + nominal trajectory computation
// This is a JS port of the nominal (no-GIRF) path of src/koreo.cpp.
// All data stays on the user's machine; no network calls are made.

// ===========================================================================
// TWIX header parser
// ===========================================================================
// Siemens VD/VE/XA raw files are MRIR containers: a MrParcRaidFileHeader at
// byte 0 lists up to 64 measurements (adjustments, pre-scans, main scan, …).
// For our UTE sequence (wip_794) the adjustment scan is first and the imaging
// scan is last — we must pick that one, not measurement 0.
//
// VB raw files have no RAID header; treat the whole file as one measurement.

const TEXT_SCAN_BYTES = 8 * 1024 * 1024; // protocol text is <<8 MB in all formats we've seen
const RAID_MAX_ENTRIES = 64;
const RAID_ENTRY_SIZE = 152;             // measId(4)+fileId(4)+off(8)+len(8)+patName(64)+protName(64)

function decodeCString(bytes) {
  const z = bytes.indexOf(0);
  return new TextDecoder("latin1")
    .decode(z < 0 ? bytes : bytes.subarray(0, z)).trim();
}

/**
 * Enumerate measurements in a TWIX file. Always returns at least one entry.
 * Does not read protocol text; just returns byte ranges + names.
 */
async function listTwixMeasurements(file) {
  const headBuf = await file.slice(0, 8 + RAID_MAX_ENTRIES * RAID_ENTRY_SIZE).arrayBuffer();
  if (headBuf.byteLength < 8) throw new Error("File is too short to contain a TWIX header.");
  const dv = new DataView(headBuf);

  // VD/VE/XA signature: first u32 = 0, second u32 = measurement count in [1, 64].
  const magic0 = dv.getUint32(0, true);
  const nMeas  = dv.getUint32(4, true);
  if (magic0 !== 0 || nMeas < 1 || nMeas > RAID_MAX_ENTRIES) {
    return [{
      index: 0, measId: 0,
      offset: 0, length: file.size,
      patName: "", protName: "",
      container: "VB",
    }];
  }
  const declaredHeaderSize = 8 + nMeas * RAID_ENTRY_SIZE;
  if (headBuf.byteLength < declaredHeaderSize)
    throw new Error("TWIX RAID header is truncated.");

  const entries = [];
  let p = 8;
  const u8 = new Uint8Array(headBuf);
  for (let i = 0; i < nMeas; ++i) {
    const measId = dv.getUint32(p, true);            p += 4;
    const fileId = dv.getUint32(p, true);            p += 4;
    const offLo  = dv.getUint32(p, true);
    const offHi  = dv.getUint32(p + 4, true);        p += 8;
    const lenLo  = dv.getUint32(p, true);
    const lenHi  = dv.getUint32(p + 4, true);        p += 8;
    const patBytes  = u8.subarray(p, p + 64);        p += 64;
    const protBytes = u8.subarray(p, p + 64);        p += 64;
    const offset = offHi * 0x100000000 + offLo;
    const length = lenHi * 0x100000000 + lenLo;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < declaredHeaderSize || length <= 0 || offset + length > file.size)
      throw new Error(`TWIX measurement #${i} has an invalid byte range.`);
    entries.push({
      index: i,
      measId, fileId,
      offset, length,
      patName:  decodeCString(patBytes),
      protName: decodeCString(protBytes),
      container: "VD",
    });
  }
  return entries;
}

/**
 * Pick the correct measurement: the main imaging scan of the UTE sequence.
 * Heuristics, in priority order:
 *   1. protName matches /wip_?794|ute|dude|davide/i  → use it (last match wins,
 *      because adjustment scans are placed first).
 *   2. Otherwise use the last measurement (Siemens convention for the main scan).
 */
function pickUteMeasurement(meas) {
  if (meas.length === 1) return meas[0];
  const uteRe = /wip_?794|\bute\b|dude|davide/i;
  for (let i = meas.length - 1; i >= 0; --i) {
    if (uteRe.test(meas[i].protName)) return meas[i];
  }
  return meas[meas.length - 1];
}

/**
 * Read up to `TEXT_SCAN_BYTES` of ASCII-decodable data starting at a given
 * byte offset. Siemens headers put the MrProtocol text near the top of each
 * measurement's header region, so this slice is more than enough.
 */
async function readMeasurementText(file, measurement) {
  const want = Math.min(measurement.length || TEXT_SCAN_BYTES, TEXT_SCAN_BYTES);
  const end = Math.min(file.size, measurement.offset + want);
  const buf = await file.slice(measurement.offset, end).arrayBuffer();
  return new TextDecoder("latin1").decode(buf);
}

// ===========================================================================
// UteSeqData binary extractor
// ===========================================================================
// Each UTE raw file embeds a SeqDataHeader + UteSeqData struct. This gives us
// the authoritative per-axis gradient delays and, crucially, the scanner-type
// enum that IceProgramUte uses to pick the right GIRF. Port of
// oreo-dev/extract_ute_seqdata.m.

// iScannerTypeGirf values must stay in sync with WIPdefines_ute.h /
// IceProgramUte/UteFunctor.cpp switch. The filename in parentheses is the
// string IceProgramUte appends to "sp2dGIRF_" (see UteFunctor.cpp:229-258).
export const SCANNER_TYPE = {
  0:  { name: "Unknown",    file: ""          },
  1:  { name: "SolaXJ",     file: "SolaXJ"    },
  2:  { name: "SolaFitXJ",  file: "SolaFitXJ" },
  3:  { name: "SolaXQ",     file: "SolaXQ"    },
  4:  { name: "SolaFitXQ",  file: "SolaFitXQ" },
  5:  { name: "VidaXQ",     file: "VidaXQ"    },
  6:  { name: "VidaFitXQ",  file: "VidaFitXQ" },
  7:  { name: "VidaXT",     file: "VidaXT"    },
  // ICE literally swaps these two when forming the filename:
  8:  { name: "TerraXW60",  file: "TerraXT"   },   // UteFunctor.cpp:247
  9:  { name: "TerraXT60",  file: "TerraXR"   },   // UteFunctor.cpp:245
  10: { name: "Prisma",     file: "Prisma"    },
  11: { name: "FreeMax",    file: "FreeMax"   },
  12: { name: "FreeStar",   file: "FreeStar"  },
  13: { name: "CimaX",      file: "CimaX"     },
  14: { name: "CimaXFit",   file: "CimaXFit"  },
};

const SUPPORTED_SEQ_FLAVORS = {
  CUSTOMER_UTE_794: "customer_wip_794_ute",
  SIEMENS_UTE: "siemens_ute",
  DUDE: "dude",
  OTHER: "other",
};

// Bundled calibration files are proprietary and are never deployed with this
// public build. Users choose their own local GIRF folder/file. Localhost paths
// remain available solely for development from a private local checkout.
export function bundledGirfBasesForHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  const localDev = !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
  return localDev ? ["../girfs", "/girfs", "./girfs"] : [];
}
const DEFAULT_GIRF_BASES = bundledGirfBasesForHost(globalThis.location?.hostname);

// Locate and decode the UteSeqData packet inside a measurement byte range.
// SeqDataHeader is 60 bytes: u32 packet_size + char[52] id + u32 swapped.
// Payload = 12 × float32 + 1 × int32 = 52 bytes. Field order matches
// extract_ute_seqdata.m.
async function extractUteSeqData(file, measurement) {
  const end = Math.min(file.size, measurement.offset + (measurement.length || file.size));
  // Worst case scan ~64 MB. In practice the header sits near the start of the
  // measurement so we rarely read more than a few hundred KB.
  const SCAN_LIMIT = 64 * 1024 * 1024;
  const scanEnd = Math.min(end, measurement.offset + SCAN_LIMIT);
  const buf = await file.slice(measurement.offset, scanEnd).arrayBuffer();
  const bytes = new Uint8Array(buf);

  const marker = "UteSeqData";
  const m = new TextEncoder().encode(marker + "\0");

  const idx = findBytes(bytes, m);
  if (idx < 0) return null;

  // idx = start of "U". Skip 52 (id field) + 4 (swapped) = 56 bytes.
  const payloadOff = idx + 52 + 4;
  if (payloadOff + 52 > bytes.length) return null;

  const dv = new DataView(buf, payloadOff, 52);
  return {
    fGradientDelayIso:   dv.getFloat32(0,  true),
    fGradientDelayX:     dv.getFloat32(4,  true),
    fGradientDelayY:     dv.getFloat32(8,  true),
    fGradientDelayZ:     dv.getFloat32(12, true),
    fScalingFactor:      dv.getFloat32(16, true),
    fAdDelay0Const:      dv.getFloat32(20, true),
    fRewinderRampUpTime: dv.getFloat32(24, true),
    fRewinderDuration:   dv.getFloat32(28, true),
    fRewinderRelAmpl:    dv.getFloat32(32, true),
    fGradientDelayTime:  dv.getFloat32(36, true),
    fReadoutRampUpTime:  dv.getFloat32(40, true),
    fReadoutDuration:    dv.getFloat32(44, true),
    iScannerTypeGirf:    dv.getInt32  (48, true),
  };
}

/** Port of oreo-dev/quat2mat.m. Siemens MDH stores [w, x, y, z]. */
export function quaternionToMatrix(quaternion) {
  if (!quaternion || quaternion.length !== 4) return null;
  const [w, x, y, z] = quaternion.map(Number);
  const normSquared = w*w + x*x + y*y + z*z;
  if (![w, x, y, z].every(Number.isFinite) || normSquared < 1e-8) return null;

  const ds = 2 / normSquared;
  const dxs = x*ds, dys = y*ds, dzs = z*ds;
  const dwx = w*dxs, dwy = w*dys, dwz = w*dzs;
  const dxx = x*dxs, dxy = x*dys, dxz = x*dzs;
  const dyy = y*dys, dyz = y*dzs, dzz = z*dzs;
  return [
    [1 - (dyy + dzz), dxy + dwz,       dxz - dwy],
    [dxy - dwz,       1 - (dxx + dzz), dyz + dwx],
    [dxz + dwy,       dyz - dwx,       1 - (dxx + dyy)],
  ];
}

function readQuaternionAt(dv, offset) {
  if (offset < 0 || offset + 16 > dv.byteLength) return null;
  const q = Array.from({ length: 4 }, (_, i) => dv.getFloat32(offset + 4*i, true));
  const normSquared = q.reduce((sum, value) => sum + value*value, 0);
  return q.every(Number.isFinite) && normSquared > 0.5 && normSquared < 1.5 ? q : null;
}

/**
 * Read and average slice quaternions from binary TWIX MDHs, matching
 * readTwixMat.m. Raw VD headers store SlicePos at bytes 101..128 (the MATLAB
 * reader removes bytes 21..40 first); VB stores it at bytes 97..124.
 */
export async function extractMdhSliceQuaternion(file, measurement) {
  const measurementEnd = Math.min(file.size, measurement.offset + (measurement.length || file.size));
  const headerWord = await file.slice(measurement.offset, measurement.offset + 4).arrayBuffer();
  if (headerWord.byteLength < 4) return null;
  const headerLength = new DataView(headerWord).getUint32(0, true);
  const dataStart = measurement.offset + headerLength;
  if (!(headerLength >= 4) || dataStart >= measurementEnd) return null;

  const scanBytes = Math.min(32 * 1024 * 1024, measurementEnd - dataStart);
  const buffer = await file.slice(dataStart, dataStart + scanBytes).arrayBuffer();
  const dv = new DataView(buffer);
  const isVd = measurement.container !== "VB";
  const minimumHeader = isVd ? 192 : 128;
  const evalInfoOffset = isVd ? 40 : 20;
  const quaternionOffset = isVd ? 112 : 108;
  const quaternions = [];
  let offset = 0;
    let iterations = 0;
    const MAX_MDH_ITERATIONS = 20000;

    while (offset + minimumHeader <= dv.byteLength &&
      quaternions.length < 64 && iterations++ < MAX_MDH_ITERATIONS) {
    // ulDMALength is a 25-bit field; upper bits contain DMA flags.
    const dmaLength = dv.getUint32(offset, true) & 0x01ffffff;
    if (dmaLength < minimumHeader || offset + dmaLength > dv.byteLength) break;
    const evalInfo = dv.getUint8(offset + evalInfoOffset);
    const isAcqEnd = (evalInfo & 0x01) !== 0;
    const isSyncData = (evalInfo & 0x20) !== 0;
    if (!isSyncData && !isAcqEnd) {
      const quaternion = readQuaternionAt(dv, offset + quaternionOffset);
      if (quaternion) quaternions.push(quaternion);
    }
    offset += dmaLength;
    if (isAcqEnd) break;
  }

  if (quaternions.length === 0) return null;
  // q and -q encode the same rotation. Align signs before reproducing Oreo's
  // mean(slicePos, 2) behavior, then normalize for stable display/storage.
  const reference = quaternions[0];
  const mean = [0, 0, 0, 0];
  for (const quaternion of quaternions) {
    const dot = quaternion.reduce((sum, value, i) => sum + value*reference[i], 0);
    for (let i = 0; i < 4; ++i) mean[i] += (dot < 0 ? -1 : 1) * quaternion[i];
  }
  const norm = Math.hypot(...mean);
  return norm > 0 ? mean.map(value => value / norm) : null;
}

// Simple Boyer-Moore-Horspool-ish byte search. Uint8Array.indexOf exists but
// only for single bytes; this is a manual substring search.
function findBytes(hay, needle) {
  const h = hay.length, n = needle.length;
  if (n === 0 || n > h) return -1;
  outer: for (let i = 0; i <= h - n; ++i) {
    for (let j = 0; j < n; ++j) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function findLastBytes(hay, needle) {
  for (let i = hay.length - needle.length; i >= 0; --i) {
    let match = true;
    for (let j = 0; j < needle.length; ++j) {
      if (hay[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Extract the raw scanner protocol block without re-encoding it. This mirrors
 * MeasMiner: prefer Phoenix/XProtocol, then fall back to ASCCONV.
 */
export async function extractScannerProtocol(file, measurement) {
  const want = Math.min(measurement.length || TEXT_SCAN_BYTES, TEXT_SCAN_BYTES);
  const end = Math.min(file.size, measurement.offset + want);
  const bytes = new Uint8Array(await file.slice(measurement.offset, end).arrayBuffer());
  const encode = value => new TextEncoder().encode(value);

  const formats = [
    { name: "XProtocol", open: "<XProtocol>", close: "</XProtocol>" },
    { name: "ASCCONV", open: "### ASCCONV BEGIN", close: "### ASCCONV END ###" },
  ];
  for (const format of formats) {
    const openBytes = encode(format.open);
    const closeBytes = encode(format.close);
    const start = findLastBytes(bytes, openBytes);
    if (start < 0) continue;
    const relativeEnd = findBytes(bytes.subarray(start), closeBytes);
    if (relativeEnd < 0) continue;
    const blockEnd = start + relativeEnd + closeBytes.length;
    return { bytes: bytes.slice(start, blockEnd), format: format.name };
  }
  return null;
}

function safeDownloadStem(value, fallback = "koreo_protocol") {
  const stem = String(value || "").trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return stem || fallback;
}

// Grab a numeric value from the MrProtocol ASCII dump, with optional index.
// Examples of the patterns we target (lines end with newline or semicolon):
//   sWiPMemBlock.alFree[9]                   = 200
//   sWiPMemBlock.adFree[12]                  = 0.000000
//   sRXSPEC.alDwellTime[0]                   = 3050
//   sKSpace.lBaseResolution                  = 128
//   sSliceArray.asSlice[0].dReadoutFOV       = 300.0
function matchNumber(text, name, idx) {
  const escName = name.replace(/[.[\]]/g, s => "\\" + s);
  const idxPart = idx === undefined ? "" : `\\[${idx}\\]`;
  const re = new RegExp(`${escName}${idxPart}\\s*=\\s*(-?[0-9.eE+-]+)`, "m");
  const m = text.match(re);
  return m ? parseFloat(m[1]) : undefined;
}

function matchString(text, name) {
  const escName = name.replace(/[.[\]]/g, s => "\\" + s);
  const re = new RegExp(`${escName}\\s*=\\s*(?:"([^"\\r\\n]*)"|([^;\\r\\n]+))`, "m");
  const m = text.match(re);
  const v = m ? (m[1] ?? m[2]) : undefined;
  return v ? v.trim() : undefined;
}

function matchParamString(text, keyTail) {
  const escTail = keyTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<ParamString\\."${escTail}">\\s*\\{\\s*"([^"]+)"\\s*\\}`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
}

function matchParamNumber(text, keyTail) {
  const escTail = keyTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<Param(?:Double|Long|Cardinal)\\."${escTail}">\\s*\\{\\s*(-?[0-9.eE+-]+)`,
    "m",
  );
  const m = text.match(re);
  return m ? parseFloat(m[1]) : undefined;
}

function matchLabeledNumber(text, label) {
  const escLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[\\s<{])${escLabel}\\s*:\\s*(-?[0-9.eE+-]+)`, "m");
  const m = text.match(re);
  return m ? parseFloat(m[1]) : undefined;
}

export function rotationFromSliceNormal(normal) {
  const magnitude = Math.hypot(...normal);
  if (!(magnitude > 0)) {
    return {
      matrix: [[1,0,0],[0,1,0],[0,0,1]],
      orientation: "unknown (transverse/identity fallback)",
      warning: "Slice normal was unavailable; GIRF scanner-axis rotation cannot be verified.",
    };
  }

  const unit = normal.map(value => value / magnitude);
  const abs = unit.map(Math.abs);
  const axis = abs.indexOf(Math.max(...abs));
  if (abs[axis] < 0.99) {
    return {
      matrix: [[1,0,0],[0,1,0],[0,0,1]],
      orientation: "oblique (identity fallback)",
      warning: "Oblique slice orientation requires the MDH quaternion; GIRF axis rotation is using identity.",
    };
  }

  // Only the axis permutation matters for diagonal GIRFs; orientation signs
  // cancel between Oreo's rotate-to-scanner and rotate-back operations.
  if (axis === 0) {
    return {
      matrix: [[0,0,1],[0,1,0],[-1,0,0]],
      orientation: "sagittal",
      warning: "",
    };
  }
  if (axis === 1) {
    return {
      matrix: [[1,0,0],[0,0,-1],[0,1,0]],
      orientation: "coronal",
      warning: "",
    };
  }
  return {
    matrix: [[1,0,0],[0,1,0],[0,0,1]],
    orientation: "transverse",
    warning: "",
  };
}

function normalizeTextToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function detectSequenceFlavor(seqName, protName) {
  // Classify strictly from the real sequence binary name (tSequenceFileName).
  // The protocol name is user-editable, so it is only trusted as a fallback
  // when the sequence name is missing — a random tSequenceName is rejected.
  const s = `${seqName || ""}`.toLowerCase().replace(/\\/g, "/");
  if (s.includes("wip_794_ute")) return SUPPORTED_SEQ_FLAVORS.CUSTOMER_UTE_794;
  if (s.includes("wip_dude"))    return SUPPORTED_SEQ_FLAVORS.DUDE;
  if (s.includes("%siemensseq%/ute") || /(^|\/)ute$/.test(s))
    return SUPPORTED_SEQ_FLAVORS.SIEMENS_UTE;

  if (!s) {
    const p = `${protName || ""}`.toLowerCase();
    if (p.includes("wip_794_ute")) return SUPPORTED_SEQ_FLAVORS.CUSTOMER_UTE_794;
    if (p.includes("wip_dude"))    return SUPPORTED_SEQ_FLAVORS.DUDE;
    if (p === "ute")               return SUPPORTED_SEQ_FLAVORS.SIEMENS_UTE;
  }
  return SUPPORTED_SEQ_FLAVORS.OTHER;
}

function isValidScannerType(id) {
  return Number.isInteger(id) && Object.prototype.hasOwnProperty.call(SCANNER_TYPE, id);
}

function inferScannerTypeFromMetadata(p) {
  if (isValidScannerType(p.scanner_type) && p.scanner_type !== 0) return p.scanner_type;

  const model = normalizeTextToken(p._scanner_model);
  const grad = normalizeTextToken(p._gradient_coil);
  const b0 = Number(p._field_strength_t || 0);

  if (model.includes("cimaxfit") || (model.includes("cimax") && model.includes("fit"))) return 14;
  if (model.includes("cimax")) return 13;
  if (model.includes("freestar")) return 12;
  if (model.includes("freemax") || model.includes("free.max") || Math.abs(b0 - 0.55) < 0.05) return 11;
  if (model.includes("prisma")) return 10;

  if (model.includes("terra") || Math.abs(b0 - 7.0) < 0.2) {
    if (grad.includes("xr")) return 9;
    if (grad.includes("xw") || grad.includes("xt")) return 8;
    return 8;
  }

  if (model.includes("vida")) {
    if (grad.includes("fit")) return 6;
    if (grad.includes("xt")) return 7;
    return 5;
  }

  if (model.includes("sola")) {
    if (grad.includes("fit")) return 2;
    if (grad.includes("xq")) return 3;
    if (grad.includes("xj")) return 1;
    return 1;
  }

  return 0;
}

/**
 * Extract the subset of Params needed for a nominal UTE trajectory.
 * Field indices mirror WIPdefines_ute.h conventions (see the plan).
 */
export function parseParamsFromProtocol(text) {
  const firstDef = (...vs) => vs.find(v => v !== undefined && !Number.isNaN(v));
  const firstPositive = (...vs) => vs.find(v => Number.isFinite(v) && v > 0);
  const p = {};

  // Base resolution & FOV
  p.n_base_resolution = firstDef(
    matchNumber(text, "sKSpace.lBaseResolution"),
    128,
  );
  p.fov = firstDef(
    matchNumber(text, "sSliceArray.asSlice", 0) !== undefined
      ? matchNumber(text, "sSliceArray.asSlice[0].dReadoutFOV")
      : undefined,
    matchNumber(text, "sSliceArray.asSlice[0].dReadoutFOV"),
    matchNumber(text, "asSlice[0].dReadoutFOV"),
    250,
  );

  // Dwell time (ns)
  p.dwell_time_ns = firstDef(
    matchNumber(text, "sRXSPEC.alDwellTime", 0),
    matchNumber(text, "alDwellTime", 0),
    3050,
  );

  // Number of columns in the raw data
  // Readout oversampling (%). For wip_794_ute this is sWipMemBlock.alFree[9]
  // (e.g. 150 or 200). NOTE: the protocol key is "sWipMemBlock" (lowercase p);
  // the capital-P spelling never matches, so try both. Product UTE is forced to
  // 200 later (see loadMeasurement / oreo-dev loadData.m).
  p.off_center_oversampling = firstDef(
    matchNumber(text, "sWipMemBlock.alFree", 9),
    matchNumber(text, "sWiPMemBlock.alFree", 9),
    200,
  );

  // NColMeas (raw samples per spoke before center-out halving)
  // ICE grid: NGridSize_OS = floor(NColMeas_raw * OS/200). For the resulting
  // Fourier OS to equal OS/100 (2.0 @ 200%, 1.5 @ 150%, 1.3 @ 130%), NColMeas_raw
  // is the center-out nominal readout = 2 * base (os-independent); the OS enters
  // only through the /200 term in computeGridConfig.
  p.n_col_meas_raw = p.n_base_resolution * 2;

  // Gradient correction mode
  p.gradient_correction = firstDef(
    matchNumber(text, "sWipMemBlock.alFree", 11),
    matchNumber(text, "sWiPMemBlock.alFree", 11),
    0,
  );
  p.gradient_correction_fallback = firstDef(
    matchNumber(text, "sWipMemBlock.alFree", 6),
    matchNumber(text, "sWiPMemBlock.alFree", 6),
    0,
  );
  // Scanner type (WIP alFree[16]). Authoritative source is the binary
  // UteSeqData packet (extracted separately); this ASCII value is a fallback.
  p.scanner_type = firstDef(
    matchNumber(text, "sWiPMemBlock.alFree", 16),
    0,
  );

  // Match oreo/getADCSampling.m and getGIRFSampling.m fallback order:
  // Config/Protocol ReadoutRampUpTime → RORampTime → WIP adFree{14}.
  // MATLAB cells are 1-based, so adFree{14} is protocol index [13].
  // Some historical headers label the fallback alFree{14}; accept that too,
  // but report it explicitly because it is not the primary Oreo path.
  const rampCandidates = [
    {
      source: "Config/Protocol ReadoutRampUpTime",
      value: firstPositive(
        matchLabeledNumber(text, "ReadoutRampUpTime"),
        matchNumber(text, "Config.ReadoutRampUpTime"),
        matchNumber(text, "Protocol.ReadoutRampUpTime"),
        matchNumber(text, "ReadoutRampUpTime"),
        matchParamNumber(text, "ReadoutRampUpTime"),
      ),
      warning: "",
    },
    {
      source: "Config/Protocol RORampTime",
      value: firstPositive(
        matchLabeledNumber(text, "RORampTime"),
        matchNumber(text, "Config.RORampTime"),
        matchNumber(text, "Protocol.RORampTime"),
        matchNumber(text, "RORampTime"),
        matchParamNumber(text, "RORampTime"),
      ),
      warning: "",
    },
    {
      source: "WIP adFree[13] (MATLAB adFree{14}) fallback",
      value: firstPositive(
        matchNumber(text, "sWipMemBlock.adFree", 13),
        matchNumber(text, "sWiPMemBlock.adFree", 13),
      ),
      warning: "Config/Protocol ramp time was unavailable; using WIP adFree[13] fallback. Verify before reconstruction.",
    },
    {
      source: "WIP alFree[13] (MATLAB alFree{14}) compatibility fallback",
      value: firstPositive(
        matchNumber(text, "sWipMemBlock.alFree", 13),
        matchNumber(text, "sWiPMemBlock.alFree", 13),
      ),
      warning: "Config/Protocol ramp time and WIP adFree[13] were unavailable; using alFree[13]. Verify before reconstruction.",
    },
  ];
  const ramp = rampCandidates.find(candidate => candidate.value !== undefined);
  p.readout_ramp_up_time = ramp?.value ?? 160;
  p._ramp_source = ramp?.source ?? "hardcoded 160 µs last resort";
  p._ramp_warning = ramp?.warning || (ramp ? "" :
    "No ReadoutRampUpTime, RORampTime, or WIP index [13] was found; using 160 µs last resort. Do not trust the trajectory until verified.");

  // Gradient delay time (µs)
  p.gradient_delay_time = firstDef(
    matchNumber(text, "sWiPMemBlock.adFree", 12),
    0,
  );
  p.ad_delay0_const = firstDef(
    matchNumber(text, "sWiPMemBlock.adFree", 8),
    0,
  );
  p.adc_to_readout_gradient_delay = firstDef(
    matchNumber(text, "sWiPMemBlock.alFree", 5),
    0,
  );
  p.nx_const_delay = firstDef(
    matchNumber(text, "sWiPMemBlock.alFree", 26),
    0,
  );

  // Per-axis gradient delays (µs). Some protocols store these in alFree[7..9]
  p.gd_iso = firstDef(matchNumber(text, "sWiPMemBlock.adFree", 15), 0);
  p.gd_x   = firstDef(matchNumber(text, "sWiPMemBlock.adFree", 16), 0);
  p.gd_y   = firstDef(matchNumber(text, "sWiPMemBlock.adFree", 17), 0);
  p.gd_z   = firstDef(matchNumber(text, "sWiPMemBlock.adFree", 18), 0);

  // Off-center (mm)
  p.off_center = [
    firstDef(matchNumber(text, "sSliceArray.asSlice[0].sPosition.dSag"), 0),
    firstDef(matchNumber(text, "sSliceArray.asSlice[0].sPosition.dCor"), 0),
    firstDef(matchNumber(text, "sSliceArray.asSlice[0].sPosition.dTra"), 0),
  ];
  p.slice_normal = [
    firstDef(matchNumber(text, "sSliceArray.asSlice[0].sNormal.dSag"), 0),
    firstDef(matchNumber(text, "sSliceArray.asSlice[0].sNormal.dCor"), 0),
    firstDef(matchNumber(text, "sSliceArray.asSlice[0].sNormal.dTra"), 0),
  ];

  // Number of radial views (projections)
  p.n_projections = firstDef(
    matchNumber(text, "sKSpace.lRadialViews"),
    matchNumber(text, "sWiPMemBlock.alFree", 0),
    10000,
  );
  p.n_echoes = firstDef(matchNumber(text, "lContrasts"), 1);
  p.n_repetitions = firstDef(matchNumber(text, "lRepetitions"), 1);

  // Oreo rotates diagonal scanner-axis GIRF responses using the MDH slice
  // quaternion. For strict orthogonal orientations the protocol normal gives
  // the exact response permutation without needing the quaternion.
  const sliceRotation = rotationFromSliceNormal(p.slice_normal);
  p.rot_matrix = sliceRotation.matrix;
  p._slice_orientation = sliceRotation.orientation;
  p._slice_orientation_warning = sliceRotation.warning;

  // Scanner model string, for display only
  p._scanner_model = matchString(text, "Dicom.ManufacturersModelName") ||
                     matchString(text, "sProtConsistencyInfo.tSystemType") ||
                     matchString(text, "tSystemType") ||
                     matchString(text, "sProtConsistencyInfo.tBaselineString") ||
                     matchParamString(text, "ManufacturersModelName") ||
                     matchParamString(text, "tSystemType") ||
                     matchParamString(text, "tBaselineString") ||
                     "(unknown)";
  p._gradient_coil = matchString(text, "sGRADSPEC.asGPAData[0].sGCParameters.tName") ||
                     matchString(text, "tGradientCoil") ||
                     matchParamString(text, "tGradientCoil") ||
                     "";
  // Nominal B0 is normalized to a canonical field strength at read time so the
  // stored value is always the corrected one (1.5 / 3 / 7 T…, 0.55 T kept as-is).
  p._field_strength_t = roundFieldStrength(firstDef(
    matchNumber(text, "sProtConsistencyInfo.flNominalB0"),
    matchNumber(text, "flNominalB0"),
    0,
  ));
  p._seq_name      = matchString(text, "tSequenceFileName") ||
                     matchString(text, "tProtocolName") || "";
  return p;
}

// ===========================================================================
// Trajectory engine (JS port of src/koreo.cpp, nominal / no-GIRF path)
// ===========================================================================
const GRID_BASE = 4;

export function computeGridConfig(p) {
  const ncmRaw = p.n_col_meas_raw > 0
    ? p.n_col_meas_raw
    : p.n_base_resolution * 2;

  const nGridOS = Math.floor(
    Math.floor(ncmRaw * p.off_center_oversampling / 200) / GRID_BASE
  ) * GRID_BASE;

  const nColMeas = nGridOS / 2;
  const dwellMult = 200 / p.off_center_oversampling * 2;
  const samplingInt = 1e-3 * dwellMult * p.dwell_time_ns;

  return {
    n_grid_size_os: nGridOS,
    n_col_meas: nColMeas,
    n_col: nColMeas,
    n_col_ima: p.n_base_resolution,
    fourier_os: nGridOS / p.n_base_resolution,
    sampling_int: samplingInt,
    dwell_mult: dwellMult,
  };
}

// Port of compute_adc_sampling, echo 0 (center-out) only.
export function computeADCSamplingEcho0(p, g) {
  const nPts = g.n_col_meas + 1;
  const si = g.sampling_int;
  const dRampTime = p.readout_ramp_up_time;
  const timeShift0 = -(p.gradient_delay_time) - (p.ad_delay0_const)
                     + (p.adc_to_readout_gradient_delay) - (p.gd_iso);
  const rampPts = Math.floor(0.5 + dRampTime / 10);
  const dg = rampPts > 0 ? 1.0 / rampPts : 1.0;
  const dg0 = dg / 2;
  const calOS = 400;

  const m_dk = new Float64Array(nPts);
  let dk = 0;
  for (let i = 1; i < nPts; ++i) {
    const t = i * si;
    if (t > dRampTime + si + timeShift0) {
      dk += si;
    } else {
      for (let j = 0; j < calOS; ++j) {
        const tj = (i - 1) * si + j * si / calOS;
        let grad = 1;
        if (tj < timeShift0) grad = 0;
        else if (tj < dRampTime + timeShift0)
          grad = dg0 + dg * Math.floor((tj - timeShift0) / 10);
        dk += grad * si / calOS;
      }
    }
    m_dk[i] = dk;
  }
  // Normalize
  const dkEnd = m_dk[g.n_col_meas];
  if (dkEnd > 0) {
    const lessMomentum = dkEnd / ((g.n_col_meas + 1) * si);
    for (let i = 0; i < nPts; ++i)
      m_dk[i] = g.n_col_meas * m_dk[i] * lessMomentum / dkEnd;
  }
  return m_dk;
}

// Port of correct_line. `sx`, `sy`, `sz` are per-axis k-space sampling arrays
// (length n_col_meas+1). For nominal / delay-only trajectories all three are
// the same scalar m_dk; for GIRF correction each axis has its own values.
// Writes directly into out[Read/Phase/Slice] arrays at the given offset to
// avoid per-spoke allocations in the hot loop.
function correctLineInto(
  dakx, daky, dakz, rot, sx, sy, sz, g,
  outRead, outPhase, outSlice, outOffset, nSamples,
) {
  const center = g.n_col_ima * g.fourier_os / 2;
  // Phase=Y row0, Read=X row1, Slice=Z row2 in ICE convention.
  const r00=rot[0][0], r01=rot[0][1], r02=rot[0][2];
  const r10=rot[1][0], r11=rot[1][1], r12=rot[1][2];
  const r20=rot[2][0], r21=rot[2][1], r22=rot[2][2];

  // Rotation to physical is constant per spoke.
  const xR = r00*daky + r10*dakx + r20*dakz;
  const yR = r01*daky + r11*dakx + r21*dakz;
  const zR = r02*daky + r12*dakx + r22*dakz;

  // Fast path: sx===sy===sz (nominal). The sample coordinate is just
  //   out = R · ([xR, yR, zR] * m[j]) + center
  // which collapses to a 3-mul + 3-add per sample.
  if (sx === sy && sy === sz) {
    const m = sx;
    const dx = r00*xR + r01*yR + r02*zR;
    const dy = r10*xR + r11*yR + r12*zR;
    const dz = r20*xR + r21*yR + r22*zR;
    for (let j = 0; j < nSamples; ++j) {
      const v = m[j];
      outRead [outOffset + j] = dy * v + center; // [Read, Phase, Slice] store
      outPhase[outOffset + j] = dx * v + center;
      outSlice[outOffset + j] = dz * v + center;
    }
    return;
  }

  // GIRF path: per-axis sampling differs.
  for (let j = 0; j < nSamples; ++j) {
    const xM = xR * sx[j], yM = yR * sy[j], zM = zR * sz[j];
    const rx = r00*xM + r01*yM + r02*zM;
    const ry = r10*xM + r11*yM + r12*zM;
    const rz = r20*xM + r21*yM + r22*zM;
    outRead [outOffset + j] = ry + center;
    outPhase[outOffset + j] = rx + center;
    outSlice[outOffset + j] = rz + center;
  }
}

const TRAJECTORY_MODE = {
  MIN_DISC_NEW: "mindiscnew",
  MIN_DISC_OLD: "mindiscold",
  FIBONACCI: "fibonacci",
};

const DEFAULT_TRAJECTORY_MODE = TRAJECTORY_MODE.MIN_DISC_NEW;

// Fibonacci-sphere spokes retained as an alternative mode.
function fibonacciSpokes(n) {
  const polar = new Float64Array(n);
  const azim  = new Float64Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; ++i) {
    const z = 1 - (i + 0.5) * 2 / n;        // -1..1
    polar[i] = Math.acos(z);                // [0, pi]
    azim[i]  = (i * golden) % (2 * Math.PI);
  }
  return { polar, azim };
}

// Port of oreo-dev/trajectory.m for numFrames=1, projpFrame=n.
function minDiscSpokes(n, useOldStep = false, scale = 1.0) {
  const polar = new Float64Array(n);
  const azim  = new Float64Array(n);
  const twoPi = 2 * Math.PI;
  const eps = 1e-10;

  const s = (Number.isFinite(scale) && scale > 0) ? scale : 1.0;
  let virtualTotal = Math.round(n / s);
  if (virtualTotal < 1) virtualTotal = 1;

  let prev = 0;
  for (let i = 0; i < n; ++i) {
    const dVirtualIndex = i / s;
    let dH;
    if (virtualTotal <= 1) {
      dH = 0;
    } else {
      dH = -1 + 2 * dVirtualIndex / (virtualTotal - 1);
    }
    dH = Math.max(-1, Math.min(1, dH));
    polar[i] = Math.acos(dH);

    if (i === 0) {
      azim[i] = 0;
      prev = 0;
      continue;
    }

    const dSinTheta = 1 - dH * dH;
    if (dSinTheta < eps) {
      azim[i] = prev;
      continue;
    }

    const num = useOldStep ? 3.6 : Math.sqrt(4 * Math.PI);
    const den = Math.sqrt(Math.max(virtualTotal * dSinTheta, eps));
    const next = (prev + num / den) % twoPi;
    azim[i] = Number.isFinite(next) ? next : prev;
    prev = azim[i];
  }
  return { polar, azim };
}

function buildSpokes(n, p) {
  const modeRaw = String(p?.trajectory_mode || DEFAULT_TRAJECTORY_MODE).toLowerCase();
  const mode = modeRaw.replace(/[_\s-]+/g, "");

  if (mode === TRAJECTORY_MODE.FIBONACCI) {
    return fibonacciSpokes(n);
  }
  if (mode === TRAJECTORY_MODE.MIN_DISC_OLD) {
    return minDiscSpokes(n, true, p?.trajectory_scale || 1.0);
  }
  // Default (and fallback) mode: minDiscNew.
  return minDiscSpokes(n, false, p?.trajectory_scale || 1.0);
}

/**
 * Compute a 3D radial center-out trajectory. If `girf` is provided, its
 * per-axis GIRF-corrected k-space sampling is used instead of the nominal
 * scalar m_dk; otherwise a pure nominal trajectory is returned.
 */
export function computeTrajectory(p, nSpokes, girf, flatDcf = true) {
  const g = computeGridConfig(p);
  const mdk = computeADCSamplingEcho0(p, g);

  // Convert double-precision sampling arrays to Float32 once, so the per-sample
  // writes in the hot loop stay in one numeric domain.
  const mdk32 = Float32Array.from(mdk);
  let sx = mdk32, sy = mdk32, sz = mdk32;
  if (girf) {
    const gs = computeGirfSampling(p, g, girf);
    sx = gs.x; sy = gs.y; sz = gs.z;
  }

  const { polar, azim } = buildSpokes(nSpokes, p);
  const nSamples = g.n_col_meas;
  const kxAll = new Float32Array(nSpokes * nSamples);
  const kyAll = new Float32Array(nSpokes * nSamples);
  const kzAll = new Float32Array(nSpokes * nSamples);

  // Build grid-coordinate trajectory directly into output, then normalize
  // once at the end (one pass, no extra allocations).
  for (let s = 0; s < nSpokes; ++s) {
    const sp = Math.sin(polar[s]), cp = Math.cos(polar[s]);
    const sa = Math.sin(azim[s]),  ca = Math.cos(azim[s]);
    correctLineInto(
      sp*ca, sp*sa, cp, p.rot_matrix, sx, sy, sz, g,
      kxAll, kyAll, kzAll, s * nSamples, nSamples,
    );
  }

  // In-place grid → normalized [-0.5, 0.5]
  const gridSize = g.n_grid_size_os;
  const centerN  = gridSize / 2;
  const inv = 1 / gridSize;
  const N = kxAll.length;
  for (let i = 0; i < N; ++i) {
    kxAll[i] = (kxAll[i] - centerN) * inv;
    kyAll[i] = (kyAll[i] - centerN) * inv;
    kzAll[i] = (kzAll[i] - centerN) * inv;
  }

  // Oreo's flat getDCF path uses delayed nominal m_dk even for a GIRF
  // trajectory. The uncut mode retains the actual GIRF-X/nominal profile.
  const radialProfile = flatDcf ? oreoFlatDcfProfile(mdk, p, g) : (girf ? sx : mdk);
  const { weights: dcf, nyquistRadius } = densityCompensation(radialProfile, g, nSpokes, flatDcf);

  return {
    kx: kxAll, ky: kyAll, kz: kzAll, dcf,
    n_spokes: nSpokes, n_samples: nSamples, grid: g,
    girf_applied: !!girf,
    girf_delay_us: girf ? GIRF_DELAY_US : 0,
    flat_dcf: flatDcf,
    dcf_nyquist_radius: nyquistRadius,
  };
}

/**
 * Same as computeTrajectory, but processes spokes in chunks and yields to the
 * event loop between chunks so a progress bar can update and the UI stays
 * responsive. `onProgress(fraction)` is called after each chunk.
 */
async function computeTrajectoryChunked(p, nSpokes, girf, onProgress, flatDcf = true) {
  const g = computeGridConfig(p);
  const mdk = computeADCSamplingEcho0(p, g);
  const mdk32 = Float32Array.from(mdk);
  let sx = mdk32, sy = mdk32, sz = mdk32;
  let radialProfile = mdk;
  if (girf) {
    const gs = computeGirfSampling(p, g, girf);
    sx = Float32Array.from(gs.x); sy = Float32Array.from(gs.y); sz = Float32Array.from(gs.z);
    radialProfile = gs.x;
  }

  const { polar, azim } = buildSpokes(nSpokes, p);
  const nSamples = g.n_col_meas;
  const kxAll = new Float32Array(nSpokes * nSamples);
  const kyAll = new Float32Array(nSpokes * nSamples);
  const kzAll = new Float32Array(nSpokes * nSamples);

  const CHUNK = 3000;
  for (let s0 = 0; s0 < nSpokes; s0 += CHUNK) {
    const s1 = Math.min(nSpokes, s0 + CHUNK);
    for (let s = s0; s < s1; ++s) {
      const sp = Math.sin(polar[s]), cp = Math.cos(polar[s]);
      const sa = Math.sin(azim[s]),  ca = Math.cos(azim[s]);
      correctLineInto(
        sp*ca, sp*sa, cp, p.rot_matrix, sx, sy, sz, g,
        kxAll, kyAll, kzAll, s * nSamples, nSamples,
      );
    }
    if (onProgress) onProgress(s1 / nSpokes);
    await new Promise(r => setTimeout(r, 0));   // yield to the UI
  }

  const gridSize = g.n_grid_size_os;
  const centerN  = gridSize / 2;
  const inv = 1 / gridSize;
  const N = kxAll.length;
  for (let i = 0; i < N; ++i) {
    kxAll[i] = (kxAll[i] - centerN) * inv;
    kyAll[i] = (kyAll[i] - centerN) * inv;
    kzAll[i] = (kzAll[i] - centerN) * inv;
  }

  if (flatDcf) radialProfile = oreoFlatDcfProfile(mdk, p, g);
  const { weights: dcf, nyquistRadius } = densityCompensation(radialProfile, g, nSpokes, flatDcf);

  return {
    kx: kxAll, ky: kyAll, kz: kzAll, dcf,
    n_spokes: nSpokes, n_samples: nSamples, grid: g,
    girf_applied: !!girf,
    girf_delay_us: girf ? GIRF_DELAY_US : 0,
    flat_dcf: flatDcf,
    dcf_nyquist_radius: nyquistRadius,
  };
}

/**
 * Lightweight 1-D diagnostics for the preview. Always returns the nominal
 * readout gradient waveform (`gNom`, 1 µs raster) and nominal k-space sampling
 * (`kNom`, ADC raster, [0, 0.5]); for the nominal case all axes coincide so a
 * single reference curve suffices. When a GIRF is supplied, the per-axis
 * corrected gradients/trajectories are returned in `girf` so the preview can
 * overlay them on top of the nominal reference. Independent of spoke count.
 */
export function computeSamplingProfiles(p, girf) {
  const g = computeGridConfig(p);
  const gridSize = g.n_grid_size_os;
  const nK = g.n_col_meas;

  // Nominal gradient trapezoid (1 µs raster) and nominal k-space (ADC raster).
  const { nom } = buildNominalGradient(p, g);
  const mdk = computeADCSamplingEcho0(p, g);
  const toK = a => {
    const k = new Float64Array(a.length < nK ? a.length : nK);
    for (let j = 0; j < k.length; ++j) k[j] = a[j] / gridSize;   // 0..0.5
    return k;
  };

  const profiles = {
    girf_applied: !!girf,
    gNom: Float64Array.from(nom),
    kNom: toK(mdk),
    girf: null,
  };

  if (girf) {
    const gs = computeGirfSampling(p, g, girf);
    profiles.girf = {
      // Nominal references on the same (ADC dwell) raster as the GIRF result.
      gNomRef: gs.roGrad,
      kNomRef: toK(gs.kNomGrad),
      gx: gs.predX, gy: gs.predY, gz: gs.predZ,
      kx: toK(gs.x), ky: toK(gs.y), kz: toK(gs.z),
    };
  }
  return profiles;
}

export function densityCompensation(mdk, g, nProj, flatAfterNyquist = false) {
  // Port of oreo-dev/getDCF.m. `mdk` is already in the same grid-coordinate
  // units used by MATLAB's delayDK(m_dk) * N * os call.
  const n = Math.min(g.n_col_meas + 1, mdk.length);
  const r = Array.from(mdk).slice(0, n);
  const den = new Float32Array(n);

  // MATLAB first computes pi*Δ(k^3)/(6*NProj), then multiplies by
  // 6*NProj/pi*0.2 for ICE-compatible scaling, leaving 0.2*Δ(k^3).
  if (n > 1) den[0] = 0.2 * Math.abs(r[1] ** 3);
  for (let i = 1; i < n - 1; ++i) {
    den[i] = 0.2 * Math.abs(
      (r[i] + r[i + 1]) ** 3 - (r[i] + r[i - 1]) ** 3,
    );
  }

  // Davide's 3-D radial Nyquist diameter from getDCF.m, filterFactor = 1.
  // It is capped at N (the oversampled grid size), then converted to radius.
  const nyquistDiameter = Math.min(2 * Math.sqrt(2 * nProj / Math.PI), g.n_grid_size_os);
  const nyquistRadius = nyquistDiameter / 2;
  if (flatAfterNyquist && n > 1) {
    let nyquistDensity = den[0];
    for (let i = 0; i < n; ++i) {
      if (Math.abs(r[i]) < nyquistRadius) nyquistDensity = den[i];
    }
    for (let i = 0; i < n; ++i) {
      if (Math.abs(r[i]) > nyquistRadius) den[i] = nyquistDensity;
    }
  }

  return { weights: den, nyquistRadius };
}

function oreoFlatDcfProfile(mdk, p, g) {
  // getTrajectory.m: gdIso = -alFree{11}; if it does not look like a 10 µs
  // multiple, use alFree{6}; then delayDK(m_dk, gdIso/smpDT).
  let gdIso = Number(p.gradient_correction) || 0;
  if (Math.abs(gdIso % 10) > 1e-9) {
    gdIso = Number(p.gradient_correction_fallback) || 0;
  }
  return delaySamplingProfile(mdk, -gdIso / g.sampling_int);
}

// ===========================================================================
// GIRF pipeline — JS port of src/koreo.cpp {load_girf, apply_girf_correction,
// compute_girf_sampling}
// ===========================================================================

/**
 * Parse a kOreo / GIRFtool GIRF binary file. Two header variants are supported:
 *  - "old" format: 4 floats  [dim, CLen, GLen, NDir]
 *  - "new" format: 5 int32s  [dim, CLen, GLen, NDir, GLen_check]
 * Followed by float[2 * GLen * 3] interleaved re/im for axes X, Y, Z.
 */
export async function loadGirfFromFile(file) {
  const buf = await file.arrayBuffer();
  return parseGirfBuffer(buf, file.name);
}

async function loadGirfFromUrl(url, displayName) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return parseGirfBuffer(buf, displayName || url);
}

function parseGirfBuffer(buf, filename) {
  if (buf.byteLength < 20)
    throw new Error(`GIRF file too short: ${filename}`);
  const dv = new DataView(buf);

  const headerInt4 = dv.getInt32(16, true);
  const newFormat = (headerInt4 === 15200 || headerInt4 === 7600);

  let nFreq, dataOffset;
  if (newFormat) {
    nFreq = dv.getInt32(8, true);
    // readGIRF.m reads six int32 header words before the payload.
    dataOffset = 6 * 4;
  } else {
    nFreq = Math.round(dv.getFloat32(8, true));
    dataOffset = 4 * 4;
  }
  if (!Number.isFinite(nFreq) || nFreq <= 0 || nFreq > (1 << 24))
    throw new Error(`GIRF file has implausible n_freq_bins: ${nFreq}`);

  const needed = dataOffset + 2 * nFreq * 3 * 4;
  if (buf.byteLength < needed)
    throw new Error(`GIRF file truncated (need ${needed}, got ${buf.byteLength})`);

  const raw = new Float32Array(buf, dataOffset, 2 * nFreq * 3);
  const axes = [];
  for (let ax = 0; ax < 3; ++ax) {
    const re = new Float32Array(nFreq), im = new Float32Array(nFreq);
    const base = ax * 2 * nFreq;
    for (let i = 0; i < nFreq; ++i) {
      re[i] = raw[base + 2*i];
      im[i] = raw[base + 2*i + 1];
    }
    axes.push({ re, im });
  }
  return {
    n_freq_bins: nFreq,
    dwell_time_us: 2.5,
    axes,
    filename,
  };
}

// ---- FFT primitives (in-place, split-real/imag Float32Array pairs) --------

function fftRadix2(re, im, inverse) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; ++i) {
    let bit = n >>> 1;
    for (; j & bit; bit >>>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >>> 1;
    const ang = (inverse ? 1 : -1) * 2 * Math.PI / len;
    const wnR = Math.cos(ang), wnI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      for (let k = 0; k < half; ++k) {
        const uR = re[i + k],      uI = im[i + k];
        const xR = re[i + k + half], xI = im[i + k + half];
        const vR = xR * wR - xI * wI;
        const vI = xR * wI + xI * wR;
        re[i + k]        = uR + vR;
        im[i + k]        = uI + vI;
        re[i + k + half] = uR - vR;
        im[i + k + half] = uI - vI;
        const nwR = wR * wnR - wI * wnI;
        const nwI = wR * wnI + wI * wnR;
        wR = nwR; wI = nwI;
      }
    }
  }
  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; ++i) { re[i] *= s; im[i] *= s; }
  }
}

function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

// Bluestein for arbitrary length
function fftBluestein(re, im, inverse) {
  const n = re.length;
  let m = 1; while (m < 2 * n) m <<= 1;

  const chR = new Float64Array(n), chI = new Float64Array(n);
  for (let k = 0; k < n; ++k) {
    const phase = (inverse ? 1 : -1) * Math.PI * ((k * k) % (2 * n)) / n;
    chR[k] = Math.cos(phase);
    chI[k] = Math.sin(phase);
  }
  const aR = new Float64Array(m), aI = new Float64Array(m);
  const bR = new Float64Array(m), bI = new Float64Array(m);
  for (let k = 0; k < n; ++k) {
    // a[k] = x[k] * chirp[k]
    aR[k] = re[k] * chR[k] - im[k] * chI[k];
    aI[k] = re[k] * chI[k] + im[k] * chR[k];
  }
  bR[0] = chR[0]; bI[0] = chI[0];
  for (let k = 1; k < n; ++k) {
    bR[k]     =  chR[k]; bI[k]     = -chI[k];
    bR[m - k] =  chR[k]; bI[m - k] = -chI[k];
  }
  fftRadix2(aR, aI, false);
  fftRadix2(bR, bI, false);
  for (let k = 0; k < m; ++k) {
    const r = aR[k] * bR[k] - aI[k] * bI[k];
    const i = aR[k] * bI[k] + aI[k] * bR[k];
    aR[k] = r; aI[k] = i;
  }
  fftRadix2(aR, aI, true);
  const scale = inverse ? 1 / n : 1;
  for (let k = 0; k < n; ++k) {
    // y[k] = a[k] * chirp[k] * scale
    re[k] = (aR[k] * chR[k] - aI[k] * chI[k]) * scale;
    im[k] = (aR[k] * chI[k] + aI[k] * chR[k]) * scale;
  }
}

function fftInPlace(re, im, inverse) {
  if (re.length === 0) return;
  if (isPow2(re.length)) fftRadix2(re, im, inverse);
  else                   fftBluestein(re, im, inverse);
}

// fftshift: rotate by floor(N/2) for forward, ceil(N/2) for inverse
function fftshiftInPlace(re, im, inverse) {
  const n = re.length;
  const shift = inverse ? Math.ceil(n / 2) : Math.floor(n / 2);
  const tR = new Float64Array(n), tI = new Float64Array(n);
  for (let i = 0; i < n; ++i) {
    tR[i] = re[(i + shift) % n];
    tI[i] = im[(i + shift) % n];
  }
  re.set(tR); im.set(tI);
}

/**
 * Port of the GIRF application in oreo-dev/getGIRFSampling.m (ground truth).
 * `roGrad`: nominal gradient sampled at the ADC dwell raster (gstepUs µs).
 * `girfAxis`: { re, im } at the fixed 2.5 µs GIRF dwell. Returns the predicted
 * gradient (magnitude with sign-of-real) at the same raster, length roGrad.length.
 * All FFT work is done in double precision.
 */
function applyGirfCorrection(roGrad, girfAxis, nFreq, gstepUs) {
  const n = roGrad.length;
  if (n === 0 || nFreq === 0) return new Float64Array(n);
  const DW_GIRF = 2.5e-6, DW_GRAD = gstepUs * 1e-6;
  const bwGirf = 1 / DW_GIRF, bwGrad = 1 / DW_GRAD;
  const freqResGrad = bwGrad / n;
  const freqResGirf = bwGirf / nFreq;
  // Frequency resolution of GIRF must be finer than that of the gradient.
  if (freqResGrad < freqResGirf) return new Float64Array(roGrad);

  // Zero-pad gradient in time to match the GIRF frequency resolution, then FFT.
  const lengthGrad = Math.round(DW_GIRF / DW_GRAD * nFreq);
  const re = new Float64Array(lengthGrad);
  const im = new Float64Array(lengthGrad);
  for (let i = 0; i < n && i < lengthGrad; ++i) re[i] = roGrad[i];
  fftshiftInPlace(re, im, false);
  fftInPlace(re, im, false);
  fftshiftInPlace(re, im, false);

  const startIndex = Math.round(Math.abs((nFreq - lengthGrad) / 2));

  // Predicted gradient spectrum, zero-padded back to lengthGrad.
  const predR = new Float64Array(lengthGrad);
  const predI = new Float64Array(lengthGrad);
  if (bwGrad < bwGirf) {
    // Crop GIRF to the (narrower) gradient bandwidth; multiply in place.
    for (let i = 0; i < lengthGrad; ++i) {
      const gr = girfAxis.re[startIndex + i], gi = girfAxis.im[startIndex + i];
      predR[i] = re[i] * gr - im[i] * gi;
      predI[i] = re[i] * gi + im[i] * gr;
    }
  } else {
    // Crop gradient spectrum to the GIRF bandwidth, multiply, pad back.
    for (let i = 0; i < nFreq; ++i) {
      const cr = re[startIndex + i], ci = im[startIndex + i];
      const gr = girfAxis.re[i], gi = girfAxis.im[i];
      predR[startIndex + i] = cr * gr - ci * gi;
      predI[startIndex + i] = cr * gi + ci * gr;
    }
  }

  // Back to time domain.
  fftshiftInPlace(predR, predI, true);
  fftInPlace(predR, predI, true);
  fftshiftInPlace(predR, predI, true);

  // Magnitude with sign of the real part (matches MATLAB), first n samples.
  const out = new Float64Array(n);
  for (let i = 0; i < n && i < lengthGrad; ++i) {
    const sgn = predR[i] > 0 ? 1 : -1;
    out[i] = Math.hypot(predR[i], predI[i]) * sgn;
  }
  return out;
}

/**
 * Build the nominal readout gradient on the 1 µs raster: a trapezoid that ramps
 * up over `readout_ramp_up_time`, holds at unit amplitude during acquisition,
 * then ramps down. Used only for the nominal preview (the ICE nominal path).
 */
function buildNominalGradient(p, g) {
  const rampTime = p.readout_ramp_up_time;
  const roDelay  = p.adc_to_readout_gradient_delay;
  const si = 1e-3 * p.dwell_time_ns * 4 / (p.off_center_oversampling / 100);
  const gradDur = Math.ceil(g.n_col * si / 10) * 10 + rampTime + roDelay;
  const nom = new Float32Array(gradDur);
  for (let i = 0; i < gradDur; ++i) {
    if (i < roDelay) nom[i] = 0;
    else if (i < rampTime + roDelay) nom[i] = (i - roDelay) / rampTime;
    else if (i < gradDur - rampTime) nom[i] = 1;
    else                             nom[i] = (gradDur - i) / rampTime;
  }
  return { nom, rampTime, roDelay, si, gradDur };
}

// Cumulative trapezoidal integral (MATLAB cumtrapz, unit spacing) over the
// first `len` samples; returns a length-`len` array starting at 0.
function cumtrapz(y, len) {
  const c = new Float64Array(len);
  for (let i = 1; i < len; ++i) c[i] = c[i - 1] + (y[i - 1] + y[i]) / 2;
  return c;
}

// Provisional NX post-GIRF timing correction. Oreo applies delayDK() after
// getGIRFSampling(); 4.85 µs corresponds to 2.425 samples for a 2 µs raster.
const GIRF_DELAY_US = 4.85;

// Fractional sample shift matching oreo-dev/delayDK.m. Values outside the
// profile are extended with the nearest endpoint, as in the MATLAB padding.
function delaySamplingProfile(src, delaySamples) {
  const out = new Float64Array(src.length);
  const last = src.length - 1;
  for (let i = 0; i < src.length; ++i) {
    const pos = i + delaySamples;
    if (pos <= 0) {
      out[i] = src[0];
    } else if (pos >= last) {
      out[i] = src[last];
    } else {
      const lo = Math.floor(pos);
      const fraction = pos - lo;
      out[i] = src[lo] + fraction * (src[lo + 1] - src[lo]);
    }
  }
  return out;
}

/**
 * Port of oreo-dev/getGIRFSampling.m. Builds the nominal readout gradient on the
 * ADC dwell raster (gstep = samplingInt), convolves it with the per-axis GIRF,
 * integrates (cumtrapz) to k-space, and normalizes. Returns the GIRF k-space
 * sampling (x/y/z, grid units), the predicted gradients (predX/Y/Z), plus the
 * nominal gradient/trajectory references (roGrad / kNomGrad) on the same raster.
 */
function computeGirfSampling(p, g, girf) {
  const nCol = g.n_col;                 // NColMeas
  const rampTime = p.readout_ramp_up_time;
  const gstep = g.sampling_int;         // samplingInt (µs) — same as MATLAB
  const rampPts = Math.max(1, Math.floor(rampTime / gstep));

  // roGrad: ramp-up (0→1) + plateau (1), length nCol, then reversed ramp (1→0).
  const roLen = nCol + rampPts;
  const roGrad = new Float64Array(roLen);
  for (let i = 0; i < nCol; ++i) roGrad[i] = 1;
  for (let i = 0; i < rampPts; ++i) roGrad[i] = rampPts > 1 ? i / (rampPts - 1) : 1;
  for (let i = 0; i < rampPts; ++i) roGrad[nCol + i] = roGrad[rampPts - 1 - i];
  const gradLen = nCol;

  const predX = applyGirfCorrection(roGrad, girf.axes[0], girf.n_freq_bins, gstep);
  const predY = applyGirfCorrection(roGrad, girf.axes[1], girf.n_freq_bins, gstep);
  const predZ = applyGirfCorrection(roGrad, girf.axes[2], girf.n_freq_bins, gstep);

  // Integrate to k-space (first gradLen samples), plus nominal reference.
  const kx = cumtrapz(predX, gradLen);
  const ky = cumtrapz(predY, gradLen);
  const kz = cumtrapz(predZ, gradLen);
  const kNom = cumtrapz(roGrad, gradLen);

  // Calibrate the GIRF integral with the nominal acquired readout moment.
  // This preserves the physical ramp-up moment deficit instead of forcing the
  // largest local GIRF axis to 0.5.
  const mdk = computeADCSamplingEcho0(p, g);
  const mdkMax = mdk[g.n_col_meas];
  const nomAcqMax = kNom[gradLen - 1] || 1;
  const scale = mdkMax / nomAcqMax;

  const delaySamples = GIRF_DELAY_US / gstep;
  // Oreo calls delayDK() on the acquired-length GIRF arrays. Apply that first;
  // only then append the extra sample needed by the webapp DCF representation.
  const scaledAndDelayed = src => {
    const acquired = new Float64Array(gradLen);
    for (let i = 0; i < gradLen; ++i) acquired[i] = src[i] * scale;
    const delayed = delaySamplingProfile(acquired, delaySamples);
    const extended = new Float64Array(gradLen + 1);
    extended.set(delayed);
    extended[gradLen] = 2 * delayed[gradLen - 1] - delayed[gradLen - 2];
    return extended;
  };
  const x = scaledAndDelayed(kx);
  const y = scaledAndDelayed(ky);
  const z = scaledAndDelayed(kz);
  const kNomGrad = new Float64Array(gradLen + 1);
  for (let i = 0; i < gradLen; ++i) kNomGrad[i] = kNom[i] * scale;
  kNomGrad[gradLen] = 2 * kNomGrad[gradLen - 1] - kNomGrad[gradLen - 2];

  return {
    x, y, z,
    predX, predY, predZ, roGrad, kNomGrad,
    delay_us: GIRF_DELAY_US,
    delay_samples: delaySamples,
  };
}

// ===========================================================================
// NumPy .npy writer (little-endian float32 arrays, format v1.0)
// ===========================================================================
function writeNpy(arr, shape) {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
  // Header is padded so (10 + headerLen) % 64 == 0 and last char is '\n'
  const preamble = 10;
  let hdr = header;
  const pad = 64 - ((preamble + hdr.length + 1) % 64);
  hdr += " ".repeat(pad) + "\n";

  const buf = new ArrayBuffer(preamble + hdr.length + arr.byteLength);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // Magic + version
  u8.set([0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59], 0); // \x93NUMPY
  u8[6] = 1; u8[7] = 0;                              // major, minor
  view.setUint16(8, hdr.length, true);
  for (let i = 0; i < hdr.length; ++i) u8[10 + i] = hdr.charCodeAt(i);
  u8.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), preamble + hdr.length);
  return new Blob([u8], { type: "application/octet-stream" });
}

// Bundle multiple arrays into a .npz (uncompressed zip).
async function writeNpzAsync(arrays) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = (function() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; ++n) {
      let c = n;
      for (let k = 0; k < 8; ++k) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = buf => {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; ++i)
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  for (const [name, { data, shape }] of Object.entries(arrays)) {
    const npy = writeNpy(data, shape);
    const fileBuf = new Uint8Array(await npy.arrayBuffer());
    const fname = enc.encode(name + ".npy");
    const crc = crc32(fileBuf);
    const localHeader = new Uint8Array(30 + fname.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, fileBuf.length, true);
    lv.setUint32(22, fileBuf.length, true);
    lv.setUint16(26, fname.length, true);
    localHeader.set(fname, 30);
    parts.push(localHeader, fileBuf);

    const centralEntry = new Uint8Array(46 + fname.length);
    const cv = new DataView(centralEntry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, fileBuf.length, true);
    cv.setUint32(24, fileBuf.length, true);
    cv.setUint16(28, fname.length, true);
    cv.setUint32(42, offset, true);
    centralEntry.set(fname, 46);
    central.push(centralEntry);

    offset += localHeader.length + fileBuf.length;
  }
  let centralSize = 0; for (const c of central) centralSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/octet-stream" });
}

// ===========================================================================
// MATLAB v5 .mat writer (miMATRIX, single precision, minimal subset)
// ===========================================================================
// Writes a struct with fields { kx, ky, kz, dcf } into a v5 .mat file.

function padTo8(n) { return (8 - (n % 8)) % 8; }

function writeMatV5(vars) {
  // vars: { name: { data: Float32Array, shape: [rows, cols] } }
  const enc = new TextEncoder();
  const headerTxt = "MATLAB 5.0 MAT-file, kOreo web app v0.1                                      ";
  const header = new Uint8Array(128);
  const htBytes = enc.encode(headerTxt);
  header.set(htBytes.subarray(0, 116), 0);
  // Bytes 124-125: version 0x0100; 126-127: endian 'IM' little-endian marker
  const hv = new DataView(header.buffer);
  hv.setUint16(124, 0x0100, true);
  header[126] = 0x49; header[127] = 0x4D; // 'I','M'

  const chunks = [header];

  for (const [name, { data, shape }] of Object.entries(vars)) {
    const nameBytes = enc.encode(name);
    // 1) Array flags (mxSINGLE_CLASS = 7)
    const af = new Uint8Array(16);
    const afv = new DataView(af.buffer);
    afv.setUint32(0, 6, true);  // miUINT32
    afv.setUint32(4, 8, true);  // 8 bytes
    afv.setUint32(8, 7, true);  // class = mxSINGLE_CLASS
    afv.setUint32(12, 0, true);

    // 2) Dimensions array
    const dimsCount = shape.length;
    const dimsSize = dimsCount * 4;
    const dimsPad = padTo8(dimsSize);
    const dims = new Uint8Array(8 + dimsSize + dimsPad);
    const dv = new DataView(dims.buffer);
    dv.setUint32(0, 5, true);           // miINT32
    dv.setUint32(4, dimsSize, true);
    for (let i = 0; i < dimsCount; ++i) dv.setUint32(8 + 4*i, shape[i], true);

    // 3) Array name
    const namePad = padTo8(nameBytes.length);
    const nameBlock = new Uint8Array(8 + nameBytes.length + namePad);
    const nv = new DataView(nameBlock.buffer);
    nv.setUint32(0, 1, true);            // miINT8
    nv.setUint32(4, nameBytes.length, true);
    nameBlock.set(nameBytes, 8);

    // 4) Real part (miSINGLE = 7)
    const dataBytes = data.byteLength;
    const dataPad = padTo8(dataBytes);
    const dataBlock = new Uint8Array(8 + dataBytes + dataPad);
    const dvh = new DataView(dataBlock.buffer);
    dvh.setUint32(0, 7, true);           // miSINGLE
    dvh.setUint32(4, dataBytes, true);
    dataBlock.set(new Uint8Array(data.buffer, data.byteOffset, dataBytes), 8);

    // Wrap all four in a miMATRIX
    const body = new Uint8Array(af.length + dims.length + nameBlock.length + dataBlock.length);
    let o = 0;
    body.set(af, o); o += af.length;
    body.set(dims, o); o += dims.length;
    body.set(nameBlock, o); o += nameBlock.length;
    body.set(dataBlock, o);

    const tag = new Uint8Array(8);
    const tv = new DataView(tag.buffer);
    tv.setUint32(0, 14, true);           // miMATRIX
    tv.setUint32(4, body.length, true);
    chunks.push(tag, body);
  }
  return new Blob(chunks, { type: "application/octet-stream" });
}

// ===========================================================================
// UI wiring
// ===========================================================================
const $ = sel => document.querySelector(sel);
let g_params = null;
let g_result = null;

function setStatus(msg, kind) {
  const el = $("#status");
  el.textContent = msg;
  el.className = "status " + (kind || "");
  el.classList.remove("hidden");
}

// Round the displayed field strength to the nearest 0.5 T (1.5 T, 3 T, 7 T…),
// keeping the special 0.55 T low-field platforms at 0.55.
function roundFieldStrength(b0) {
  const v = Number(b0) || 0;
  if (v <= 0) return v;
  if (Math.abs(v - 0.55) < 0.15) return 0.55;
  return Math.round(v / 0.5) * 0.5;
}

function renderParams(p) {
  const rows = [
    ["Scanner", p._scanner_model || "(unknown)"],
    ["Sequence flavor", p._seq_flavor || SUPPORTED_SEQ_FLAVORS.OTHER],
    p._future_sequence_note ? ["Sequence note", p._future_sequence_note] : null,
    ["Scanner detect source", p._scanner_detection_source || "(not set)"],
    ["Scanner-GIRF type", p._scanner_name
        ? `${p._scanner_name} (id ${p.scanner_type})${p._scanner_girf_file ? " → " + p._scanner_girf_file : ""}`
        : `id ${p.scanner_type}`],
    p._gradient_coil ? ["Gradient coil", p._gradient_coil] : null,
    p._field_strength_t ? ["Field strength [T]", p._field_strength_t] : null,
    ["Sequence", p._seq_name || ""],
    p._seq_data_source
      ? ["SeqData source", p._seq_data_source]
      : null,
    p._measurement && p._measurement.count > 1
      ? ["TWIX measurement", `#${p._measurement.index + 1} of ${p._measurement.count} · ${p._measurement.protName || "(unnamed)"}`]
      : null,
    ["Base resolution", p.n_base_resolution],
    ["N projections", p.n_projections],
    ["N col meas raw", p.n_col_meas_raw],
    ["FOV [mm]", p.fov],
    ["Dwell time [ns]", p.dwell_time_ns],
    ["Off-center OS [%]", p.off_center_oversampling],
    ["Ramp-up time [µs]", p.readout_ramp_up_time],
    ["Ramp-up source", p._ramp_source || "(unknown)"],
    p._ramp_warning ? ["⚠ Ramp warning", p._ramp_warning] : null,
    ["Grad. delay [µs]", p.gradient_delay_time],
    ["Per-axis grad delays [µs]", `${p.gd_x?.toFixed?.(2) ?? p.gd_x}, ${p.gd_y?.toFixed?.(2) ?? p.gd_y}, ${p.gd_z?.toFixed?.(2) ?? p.gd_z}`],
    ["ADC-to-grad. delay [µs]", p.adc_to_readout_gradient_delay],
    ["Gradient correction", p.gradient_correction],
    ["Off-center [Sag,Cor,Tra mm]", p.off_center.map(v => v.toFixed(2)).join(", ")],
    ["Slice normal [Sag,Cor,Tra]", p.slice_normal.map(v => v.toFixed(4)).join(", ")],
    ["GIRF slice orientation", p._slice_orientation],
    ["Orientation source", p._slice_orientation_source || "MrProtocol slice-normal fallback"],
    p.slice_quaternion ? ["MDH quaternion [w,x,y,z]", p.slice_quaternion.map(v => v.toFixed(6)).join(", ")] : null,
    p._slice_orientation_warning ? ["⚠ Orientation warning", p._slice_orientation_warning] : null,
  ].filter(Boolean);
  const table = $("#params-table");
  table.replaceChildren(...rows.map(([key, value]) => {
    const row = document.createElement("tr");
    const keyCell = document.createElement("td");
    const valueCell = document.createElement("td");
    keyCell.textContent = String(key);
    valueCell.textContent = String(value ?? "");
    row.append(keyCell, valueCell);
    return row;
  }));

  // Editable form
  const editable = [
    "n_base_resolution","fov","dwell_time_ns","off_center_oversampling",
    "readout_ramp_up_time","gradient_delay_time","ad_delay0_const",
    "adc_to_readout_gradient_delay","n_col_meas_raw","gradient_correction",
    "nx_const_delay"
  ];
  const form = $("#params-form");
  form.replaceChildren(...editable.map(name => {
    const label = document.createElement("label");
    label.append(document.createTextNode(name));
    const input = document.createElement("input");
    input.dataset.field = name;
    input.type = "number";
    input.step = "any";
    input.value = Number.isFinite(Number(p[name])) ? String(p[name]) : "";
    label.append(input);
    return label;
  }));
  $("#params-form").oninput = ev => {
    const f = ev.target.dataset.field;
    if (!f) return;
    p[f] = parseFloat(ev.target.value);
    if (f === "readout_ramp_up_time") {
      p._ramp_source = "manual edit";
      p._ramp_warning = "";
    }
    refreshProfiles();
    scheduleCompute();
  };

  $("#params-panel").classList.remove("hidden");
  $("#traj-panel").classList.remove("hidden");
}

function drawProfiles(profiles) {
  const canvas = $("#preview");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#0b0e1c";
  ctx.fillRect(0, 0, W, H);

  const padL = 52, padR = 18, padT = 40, padB = 30, gap = 40;
  const panelW = W - padL - padR;
  const panelH = (H - padT - padB - gap) / 2;
  const axisColors = { x: "#ff6a6a", y: "#5ce08a", z: "#6aa8ff" };
  const hasGirf = !!profiles.girf;
  // Nominal is the primary curve when shown alone (solid), and a faded dashed
  // reference when GIRF-corrected axes are overlaid on top.
  const nomStyle = hasGirf
    ? { label: "nominal", color: "rgba(210,218,240,0.5)", dash: [4, 3] }
    : { label: "nominal", color: "#9fb2e6", dash: [] };

  // Gradient panel: nominal trapezoid (dashed reference) + GIRF Gx/Gy/Gz on top.
  const gradSeries = [{ ...nomStyle, data: profiles.girf ? profiles.girf.gNomRef : profiles.gNom }];
  if (profiles.girf) {
    gradSeries.push({ label: "Gx", color: axisColors.x, data: profiles.girf.gx });
    gradSeries.push({ label: "Gy", color: axisColors.y, data: profiles.girf.gy });
    gradSeries.push({ label: "Gz", color: axisColors.z, data: profiles.girf.gz });
  }
  drawLineChart(ctx, padL, padT, panelW, panelH,
    "Gradients  nominal vs Gx / Gy / Gz", "readout sample", gradSeries, {});

  // Trajectory panel: nominal k (dashed reference) + GIRF kx/ky/kz on top,
  // pinned to the physical [0, 0.5] Nyquist range.
  const kSeries = [{ ...nomStyle, data: profiles.girf ? profiles.girf.kNomRef : profiles.kNom }];
  if (profiles.girf) {
    kSeries.push({ label: "kx", color: axisColors.x, data: profiles.girf.kx });
    kSeries.push({ label: "ky", color: axisColors.y, data: profiles.girf.ky });
    kSeries.push({ label: "kz", color: axisColors.z, data: profiles.girf.kz });
  }
  drawLineChart(ctx, padL, padT + panelH + gap, panelW, panelH,
    "Trajectory  nominal vs kx / ky / kz", "readout sample", kSeries, { yRange: [0, 0.5] });

  ctx.fillStyle = "rgba(230,235,255,0.55)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    profiles.girf_applied
      ? "solid = GIRF-corrected · dashed = nominal reference"
      : "nominal — all three axes coincide",
    W / 2, H - 10);
  ctx.textAlign = "left";
}

// Draw a single labelled line chart. `series` = [{ label, color, data }].
// All series in a panel are assumed to share the same length.
// `opts.yRange` pins the y-axis; otherwise it auto-scales with headroom.
function drawLineChart(ctx, x0, y0, w, h, title, xLabel, series, opts = {}) {
  // Determine y range.
  let lo, hi;
  if (opts.yRange) {
    [lo, hi] = opts.yRange;
  } else {
    lo = Infinity; hi = -Infinity;
    for (const s of series) {
      for (let i = 0; i < s.data.length; ++i) {
        const v = s.data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { lo -= 1; hi += 1; }
    const padY = (hi - lo) * 0.1;          // 10% headroom so curves never touch the frame
    lo -= padY; hi += padY;
    if (lo > 0 && lo < (hi - lo)) lo = 0;   // anchor to zero when the data is near it
  }
  const range = hi - lo || 1;
  const xN = Math.max(1, (series[0]?.data.length || 1) - 1);
  const yOf = v => y0 + h - (v - lo) / range * h;

  // Frame.
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, w, h);

  // Horizontal gridlines + y tick labels at lo / mid / hi (and 0 if in range).
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const ticks = new Set([lo, (lo + hi) / 2, hi]);
  if (lo < 0 && hi > 0) ticks.add(0);
  for (const t of ticks) {
    const y = yOf(t);
    ctx.strokeStyle = Math.abs(t) < 1e-9 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)";
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
    ctx.fillStyle = "rgba(230,235,255,0.55)";
    ctx.fillText(t.toFixed(2), x0 - 6, y);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Series lines.
  ctx.lineWidth = 1.5;
  for (const s of series) {
    ctx.setLineDash(s.dash || []);
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    for (let i = 0; i < s.data.length; ++i) {
      const px = x0 + (i / xN) * w;
      const py = yOf(s.data[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // x-axis label (sample count).
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(230,235,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText(`${xLabel} → ${xN + 1}`, x0 + w, y0 + h + 12);
  ctx.textAlign = "left";

  // Title + legend.
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "rgba(230,235,255,0.85)";
  ctx.fillText(title, x0, y0 - 8);
  let lx = x0 + w;
  ctx.font = "11px system-ui, sans-serif";
  for (let i = series.length - 1; i >= 0; --i) {
    const s = series[i];
    const tw = ctx.measureText(s.label).width;
    lx -= tw + 16;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, y0 - 17, 10, 3);
    ctx.fillStyle = "rgba(230,235,255,0.85)";
    ctx.fillText(s.label, lx + 14, y0 - 12);
  }
}

// Recompute + redraw the 1-D diagnostic profiles from the current params and
// GIRF selection. Cheap (single readout), so it can run on every edit.
function refreshProfiles() {
  if (!g_params) return;
  const useGirf = selectedGirf();
  try {
    const profiles = computeSamplingProfiles(g_params, useGirf ? g_girf : null);
    drawProfiles(profiles);
  } catch (err) {
    console.error(err);
  }
}

// ---- Auto-compute (debounced, chunked, with progress) --------------------
let g_computeTimer = null;
let g_computeToken = 0;

// Schedule a full-trajectory compute after a short debounce so rapid edits
// (typing in a param field) collapse into a single run.
function scheduleCompute(delay = 450) {
  if (!g_params) return;
  clearTimeout(g_computeTimer);
  g_computeTimer = setTimeout(runCompute, delay);
}

async function runCompute() {
  if (!g_params) return;
  const nSpokes = parseInt($("#n-spokes").value, 10) || 1000;
  const useGirf = selectedGirf();
  const flatDcf = $("#flat-dcf")?.checked ?? true;
  const token = ++g_computeToken;              // supersede any in-flight run
  const prog = $("#compute-progress");

  if (prog) { prog.classList.remove("hidden"); prog.value = 0; }
  $("#download-mat").disabled = true;
  $("#download-npz").disabled = true;
  setStatus(`Computing ${nSpokes} spokes${useGirf ? " with GIRF" : ""}…`);
  const t0 = performance.now();

  let result;
  try {
    result = await computeTrajectoryChunked(g_params, nSpokes, useGirf ? g_girf : null, frac => {
      if (token === g_computeToken && prog) prog.value = frac;
    }, flatDcf);
  } catch (err) {
    if (token !== g_computeToken) return;
    console.error(err);
    if (prog) prog.classList.add("hidden");
    setStatus("Compute failed: " + err.message, "err");
    return;
  }
  if (token !== g_computeToken) return;        // a newer run started; discard

  g_result = result;
  if (prog) prog.classList.add("hidden");
  const ms = (performance.now() - t0).toFixed(0);
  showTrajStats(g_result);
  setStatus(`Trajectory ready (${ms} ms)${useGirf ? " [GIRF-corrected]" : " [nominal]"}. Download below.`, "ok");
  $("#download-mat").disabled = false;
  $("#download-npz").disabled = false;
  $("#download-json").disabled = false;
}

function trajectoryMatBlob(result) {
  const { n_spokes, n_samples } = result;
  return writeMatV5({
    kx:  { data: result.kx,  shape: [n_samples, n_spokes] },
    ky:  { data: result.ky,  shape: [n_samples, n_spokes] },
    kz:  { data: result.kz,  shape: [n_samples, n_spokes] },
    dcf: { data: result.dcf, shape: [result.dcf.length, 1] },
    girf_applied: { data: Float32Array.of(result.girf_applied ? 1 : 0), shape: [1, 1] },
    girf_delay_us: { data: Float32Array.of(result.girf_delay_us), shape: [1, 1] },
    flat_dcf: { data: Float32Array.of(result.flat_dcf ? 1 : 0), shape: [1, 1] },
    dcf_nyquist_radius: { data: Float32Array.of(result.dcf_nyquist_radius), shape: [1, 1] },
  });
}

async function trajectoryNpzBlob(result) {
  const shape = [result.n_spokes, result.n_samples];
  return writeNpzAsync({
    kx:  { data: result.kx,  shape },
    ky:  { data: result.ky,  shape },
    kz:  { data: result.kz,  shape },
    dcf: { data: result.dcf, shape: [result.dcf.length] },
    girf_applied: { data: Float32Array.of(result.girf_applied ? 1 : 0), shape: [1] },
    girf_delay_us: { data: Float32Array.of(result.girf_delay_us), shape: [1] },
    flat_dcf: { data: Float32Array.of(result.flat_dcf ? 1 : 0), shape: [1] },
    dcf_nyquist_radius: { data: Float32Array.of(result.dcf_nyquist_radius), shape: [1] },
  });
}

async function downloadSelectedTrajectory(format) {
  if (!g_params) return;

  const useGirf = selectedGirf();
  const nSpokes = parseInt($("#n-spokes").value, 10) || 1000;
  const flatDcf = $("#flat-dcf")?.checked ?? true;
  const mode = useGirf ? "GIRF-corrected" : "nominal";
  const suffix = useGirf ? "girf" : "nominal";
  const prog = $("#compute-progress");
  const buttons = [$("#download-mat"), $("#download-npz")];
  buttons.forEach(button => { if (button) button.disabled = true; });
  if (prog) { prog.classList.remove("hidden"); prog.value = 0; }
  setStatus(`Computing ${mode} trajectory for .${format} download…`);

  try {
    const result = await computeTrajectoryChunked(
      g_params,
      nSpokes,
      useGirf ? g_girf : null,
      fraction => { if (prog) prog.value = fraction; },
      flatDcf,
    );
    const blob = format === "mat" ? trajectoryMatBlob(result) : await trajectoryNpzBlob(result);
    triggerDownload(blob, `koreo_trajectory_${suffix}.${format}`);
    setStatus(`${mode} trajectory downloaded as .${format}.`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(`${mode} .${format} download failed: ${err.message}`, "err");
  } finally {
    if (prog) prog.classList.add("hidden");
    buttons.forEach(button => { if (button) button.disabled = false; });
  }
}

function showTrajStats(result) {
  // Walk the arrays in one pass — Math.min(...arr) throws for large Float32Arrays.
  let absMax = 0;
  const N = result.kx.length;
  for (let i = 0; i < N; ++i) {
    const ax = Math.abs(result.kx[i]);
    const ay = Math.abs(result.ky[i]);
    const az = Math.abs(result.kz[i]);
    if (ax > absMax) absMax = ax;
    if (ay > absMax) absMax = ay;
    if (az > absMax) absMax = az;
  }
  $("#traj-stats").innerHTML = `
    <table>
      <tr><td>Spokes</td><td>${result.n_spokes}</td></tr>
      <tr><td>Samples / spoke</td><td>${result.n_samples}</td></tr>
      <tr><td>Grid size OS</td><td>${result.grid.n_grid_size_os}</td></tr>
      <tr><td>Fourier OS</td><td>${result.grid.fourier_os.toFixed(3)}</td></tr>
      <tr><td>k-space range (should be ≤ 0.5)</td><td>${absMax.toFixed(4)}</td></tr>
      <tr><td>GIRF applied</td><td>${result.girf_applied ? "yes" : "no"}</td></tr>
      <tr><td>GIRF delay</td><td>${result.girf_delay_us.toFixed(2)} µs</td></tr>
      <tr><td>DCF</td><td>${result.flat_dcf ? `flat after Nyquist radius ${result.dcf_nyquist_radius.toFixed(2)}` : "radial (uncut)"}</td></tr>
    </table>`;
}

// ---- File handling -------------------------------------------------------
let g_girf = null;
let g_measurements = null;   // list of measurements in the current .dat
let g_file = null;           // currently loaded raw file handle
let g_bundled_girf_base = null;

function selectedGirf() {
  return $("#trajectory-mode")?.value === "girf" && !!g_girf;
}

function updateTrajectoryMode(girfAvailable, selectGirf = false) {
  const select = $("#trajectory-mode");
  if (!select) return;
  const girfOption = select.querySelector('option[value="girf"]');
  if (girfOption) girfOption.disabled = !girfAvailable;
  if (girfAvailable && selectGirf) select.value = "girf";
  if (!girfAvailable && select.value === "girf") select.value = "nominal";
}

function handleDragOver(ev) { ev.preventDefault(); $("#drop").classList.add("dragover"); }
function handleDragLeave() { $("#drop").classList.remove("dragover"); }

async function loadMeasurement(measurement) {
  $("#download-pro").disabled = true;
  setStatus(`Reading measurement #${measurement.index} (${measurement.protName || "unnamed"})…`);
  const text = await readMeasurementText(g_file, measurement);
  if (!/sKSpace|sWiPMemBlock|sRXSPEC/.test(text))
    throw new Error(`Measurement #${measurement.index} has no Siemens MrProtocol text.`);
  g_params = parseParamsFromProtocol(text);
  g_girf = null;
  updateTrajectoryMode(false);
  g_params._seq_flavor = detectSequenceFlavor(g_params._seq_name, measurement.protName);

  // Only real UTE sequences are supported. Reject anything else so we never
  // present a bogus trajectory for an unrelated sequence.
  if (g_params._seq_flavor === SUPPORTED_SEQ_FLAVORS.OTHER) {
    $("#params-panel")?.classList.add("hidden");
    $("#traj-panel")?.classList.add("hidden");
    throw new Error(
      `Unsupported sequence "${g_params._seq_name || measurement.protName || "unknown"}". ` +
      `Only wip_794_ute and the product UTE sequence are supported.`);
  }
  if (g_params._seq_flavor === SUPPORTED_SEQ_FLAVORS.DUDE) {
    $("#params-panel")?.classList.add("hidden");
    $("#traj-panel")?.classList.add("hidden");
    throw new Error("wip_DUDE detected — support is planned but not yet available.");
  }

  // Binary UteSeqData packet — authoritative for scanner type + per-axis delays.
  const shouldTrySeqData =
    g_params._seq_flavor === SUPPORTED_SEQ_FLAVORS.CUSTOMER_UTE_794 ||
    g_params._seq_flavor === SUPPORTED_SEQ_FLAVORS.SIEMENS_UTE;
  const seqData = shouldTrySeqData ? await extractUteSeqData(g_file, measurement) : null;
  if (seqData) {
    g_params.gd_iso                 = seqData.fGradientDelayIso;
    g_params.gd_x                   = seqData.fGradientDelayX;
    g_params.gd_y                   = seqData.fGradientDelayY;
    g_params.gd_z                   = seqData.fGradientDelayZ;
    g_params.scaling_factor         = seqData.fScalingFactor;
    g_params.ad_delay0_const        = seqData.fAdDelay0Const;
    g_params.gradient_delay_time    = seqData.fGradientDelayTime;
    g_params.readout_ramp_up_time   = seqData.fReadoutRampUpTime;
    g_params._ramp_source           = "binary UteSeqData.fReadoutRampUpTime";
    g_params._ramp_warning          = "";
    g_params.scanner_type           = seqData.iScannerTypeGirf;
    g_params._seq_data_source       = `binary UteSeqData (${g_params._seq_flavor})`;

    // oreo-dev/@oreo/loadData.m: product %SiemensSeq%/ute uses 200% oversampling.
    if (g_params._seq_flavor === SUPPORTED_SEQ_FLAVORS.SIEMENS_UTE) {
      g_params.off_center_oversampling = 200;
      g_params.n_col_meas_raw = Math.round(g_params.n_base_resolution * 2);
    }
  } else if (shouldTrySeqData) {
    g_params._seq_data_source = `SeqData expected for ${g_params._seq_flavor}, not found`;
  } else {
    g_params._seq_data_source       = "ASCII MrProtocol only";
  }

  // Oreo derives arbitrary orientation from mean(image.slicePos), whose final
  // four values are the binary MDH quaternion. Prefer that exact matrix over
  // the protocol-normal fallback used for strict orthogonal scans.
  try {
    const quaternion = await extractMdhSliceQuaternion(g_file, measurement);
    const matrix = quaternionToMatrix(quaternion);
    if (quaternion && matrix) {
      g_params.slice_quaternion = quaternion;
      g_params.rot_matrix = matrix;
      g_params._slice_orientation = "MDH quaternion (arbitrary)";
      g_params._slice_orientation_source = "binary image MDH SlicePos";
      g_params._slice_orientation_warning = "";
    } else {
      g_params.slice_quaternion = null;
      g_params._slice_orientation_source = "MrProtocol slice-normal fallback";
    }
  } catch (err) {
    console.warn("MDH slice quaternion extraction failed:", err);
    g_params.slice_quaternion = null;
    g_params._slice_orientation_source = "MrProtocol slice-normal fallback";
    g_params._slice_orientation_warning ||= `MDH quaternion read failed: ${err.message}`;
  }

  if (g_params._seq_flavor === SUPPORTED_SEQ_FLAVORS.DUDE) {
    g_params._future_sequence_note = "DUDE detected (planned support)";
  }

  let detectSource = g_params._seq_data_source;
  if (!isValidScannerType(g_params.scanner_type) || g_params.scanner_type === 0) {
    const inferredType = inferScannerTypeFromMetadata(g_params);
    if (inferredType !== 0) {
      g_params.scanner_type = inferredType;
      detectSource += " + model fallback";
    }
  }
  g_params._scanner_detection_source = detectSource;

  const st = SCANNER_TYPE[g_params.scanner_type] || SCANNER_TYPE[0];
  g_params._scanner_name     = st.name;
  g_params._scanner_girf_file = st.file ? `sp2dGIRF_${st.file}.dat` : "";

  g_params._measurement = {
    index: measurement.index,
    count: g_measurements.length,
    protName: measurement.protName,
    container: measurement.container,
  };
  $("#girf-panel")?.classList.remove("hidden");
  renderParams(g_params);
  renderMeasurementPicker();
  $("#download-pro").disabled = false;
  autoLoadGirf();
  // Default spoke count to the scan's own projection count
  const nSpokesInput = $("#n-spokes");
  if (nSpokesInput && g_params.n_projections > 0) {
    nSpokesInput.value = g_params.n_projections;
  }
  refreshProfiles();
  scheduleCompute();
  const which = g_measurements.length > 1
    ? `measurement ${measurement.index + 1}/${g_measurements.length} (${measurement.protName || "unnamed"})`
    : "single measurement";
  const rampNotice = g_params._ramp_warning ? ` ⚠ ${g_params._ramp_warning}` : "";
  setStatus(
    `Parsed ${which} — ${g_params._scanner_model} · scanner GIRF: ${g_params._scanner_name}.${rampNotice}`,
    g_params._ramp_warning ? "warn" : "ok",
  );
}

async function handleFile(file) {
  $("#drop").classList.remove("dragover");
  if (!file) return;
  $("#download-pro").disabled = true;
  $("#girf-panel")?.classList.add("hidden");
  g_file = file;
  setStatus(`Inspecting ${file.name} (${(file.size/1e6).toFixed(1)} MB)…`);
  try {
    g_measurements = await listTwixMeasurements(file);
    const chosen = pickUteMeasurement(g_measurements);
    await loadMeasurement(chosen);
  } catch (err) {
    console.error(err);
    setStatus("Parse failed: " + err.message, "err");
  }
}

async function handleGirfFile(file) {
  if (!file) return;
  try {
    setStatus(`Loading GIRF ${file.name}…`);
    g_girf = await loadGirfFromFile(file);
    updateTrajectoryMode(true, true);
    $("#girf-info").textContent =
      `✔ ${file.name} — ${g_girf.n_freq_bins} frequency bins, ${g_girf.axes.length} axes`;
    $("#girf-info").className = "girf-info ok";
    refreshProfiles();
    scheduleCompute(0);
    setStatus("GIRF loaded and GIRF-corrected trajectory selected.", "ok");
  } catch (err) {
    console.error(err);
    g_girf = null;
    updateTrajectoryMode(false);
    $("#girf-info").textContent = "✗ " + err.message;
    $("#girf-info").className = "girf-info err";
    setStatus("GIRF load failed: " + err.message, "err");
  }
}

// GIRF library: map of basename → { type, ... }, populated when the user points
// the webapp at a folder (e.g. IceProgramUte/girf/). Used to auto-pick the
// correct GIRF for the detected scanner. Loaded GIRFs are persisted in the
// browser's IndexedDB so they are remembered across sessions without ever being
// committed to the repo, served from a folder, or uploaded anywhere.
let g_girf_library = new Map();

// ---- GIRF persistence (browser-local IndexedDB) --------------------------
const IDB_NAME = "koreo", IDB_STORE = "girfs";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE))
        req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPutGirf(name, buf) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(buf, name);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function idbGetAllGirfs() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    tx.oncomplete = () => {
      const map = new Map();
      keysReq.result.forEach((k, i) => map.set(k, valsReq.result[i]));
      resolve(map);
    };
    tx.onerror = () => reject(tx.error);
  });
}

function updateGirfLibraryInfo() {
  const n = g_girf_library.size;
  const info = $("#girf-library-info");
  if (!info) return;
  info.textContent = n > 0
    ? `✔ GIRF library (${n}, stored in this browser): ${[...g_girf_library.keys()].join(", ")}`
    : "No GIRFs stored yet — load a GIRF folder/file once and it is remembered locally.";
  info.className = "girf-info " + (n > 0 ? "ok" : "");
}

// Restore any GIRFs the user previously loaded into this browser.
async function loadPersistedGirfLibrary() {
  try {
    const stored = await idbGetAllGirfs();
    for (const [name, buf] of stored) {
      if (/^sp2dGIRF_.+\.dat$/i.test(name)) g_girf_library.set(name, { type: "buffer", buf });
    }
    updateGirfLibraryInfo();
  } catch (err) {
    console.warn("GIRF library restore failed:", err);
  }
}

async function registerGirfLibrary(files) {
  let added = 0;
  for (const f of files) {
    const name = f.name || f.webkitRelativePath?.split("/").pop() || "";
    if (!/^sp2dGIRF_.+\.dat$/i.test(name)) continue;
    const buf = await f.arrayBuffer();
    g_girf_library.set(name, { type: "buffer", buf });
    try { await idbPutGirf(name, buf); } catch (err) { console.warn("GIRF persist failed:", err); }
    ++added;
  }
  const info = $("#girf-library-info");
  if (added === 0 && info) {
    info.textContent = "✗ No sp2dGIRF_*.dat files in the selected folder.";
    info.className = "girf-info err";
  } else {
    updateGirfLibraryInfo();
  }
  autoLoadGirf();
}

async function tryLoadBundledGirf(target) {
  const preferredBases = g_bundled_girf_base
    ? [g_bundled_girf_base, ...DEFAULT_GIRF_BASES.filter(b => b !== g_bundled_girf_base)]
    : DEFAULT_GIRF_BASES;

  for (const base of preferredBases) {
    const url = `${base.replace(/\/$/, "")}/${target}`;
    try {
      const girf = await loadGirfFromUrl(url, target);
      g_bundled_girf_base = base;
      return { girf, url };
    } catch {
      // Try next local static path candidate
    }
  }
  return null;
}

async function autoLoadGirf() {
  if (!g_params || !g_params._scanner_girf_file) return;
  const target = g_params._scanner_girf_file;

  try {
    setStatus(`Auto-loading GIRF for ${g_params._scanner_name}: ${target}…`);

    const localEntry = g_girf_library.get(target);
    let sourceText = "";
    if (localEntry?.type === "buffer") {
      g_girf = parseGirfBuffer(localEntry.buf, target);
      sourceText = "stored in this browser";
    } else if (localEntry?.type === "file") {
      g_girf = await loadGirfFromFile(localEntry.file);
      sourceText = "local folder";
    } else {
      const bundled = await tryLoadBundledGirf(target);
      if (!bundled) {
        const info = $("#girf-info");
        if (info && !g_girf) {
          info.textContent = `ℹ Detected scanner ${g_params._scanner_name}; expected ${target} not stored in this browser. Use “GIRF folder…” or “GIRF file…” to load it once — it will be remembered locally.`;
          info.className = "girf-info";
        }
        return;
      }
      g_girf = bundled.girf;
      sourceText = bundled.url;
    }

    $("#girf-info").textContent =
      `✔ Auto-selected ${target} for ${g_params._scanner_name} — ${g_girf.n_freq_bins} bins (${sourceText})`;
    $("#girf-info").className = "girf-info ok";
    updateTrajectoryMode(true, true);
    refreshProfiles();
    scheduleCompute(0);
    setStatus(`GIRF auto-loaded for ${g_params._scanner_name}; GIRF-corrected trajectory selected.`, "ok");
  } catch (err) {
    console.error(err);
    setStatus("GIRF auto-load failed: " + err.message, "err");
  }
}

function renderMeasurementPicker() {
  const picker = $("#measurement-picker");
  if (!g_measurements || g_measurements.length <= 1) {
    picker.classList.add("hidden");
    return;
  }
  picker.classList.remove("hidden");
  const sel = $("#measurement-select");
  sel.replaceChildren(...g_measurements.map(measurement => {
    const option = document.createElement("option");
    option.value = String(measurement.index);
    option.textContent = `#${measurement.index} · ${measurement.protName || "(unnamed)"}` +
      `${measurement.patName ? " · " + measurement.patName : ""}`;
    option.selected = g_params?._measurement?.index === measurement.index;
    return option;
  }));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Wire-up on load -----------------------------------------------------
function wireUp() {
  const drop = $("#drop"), fi = $("#file-input");
  drop.addEventListener("dragover", handleDragOver);
  drop.addEventListener("dragleave", handleDragLeave);
  drop.addEventListener("drop", ev => {
    ev.preventDefault(); handleFile(ev.dataTransfer.files[0]);
  });
  drop.addEventListener("click", () => fi.click());
  $("#browse-btn").addEventListener("click", ev => { ev.stopPropagation(); fi.click(); });
  fi.addEventListener("change", () => handleFile(fi.files[0]));

  // GIRF file input
  const girfInput = $("#girf-input");
  if (girfInput) {
    $("#girf-browse-btn").addEventListener("click", () => girfInput.click());
    girfInput.addEventListener("change", () => handleGirfFile(girfInput.files[0]));
  }

  // Re-render the preview + recompute when the trajectory mode changes.
  $("#trajectory-mode")?.addEventListener("change", () => { refreshProfiles(); scheduleCompute(0); });

  // GIRF library (folder) input — enables auto-detect
  const girfDir = $("#girf-dir-input");
  if (girfDir) {
    $("#girf-dir-browse-btn").addEventListener("click", () => girfDir.click());
    girfDir.addEventListener("change", () => registerGirfLibrary(girfDir.files));
  }

  // Measurement picker
  const sel = $("#measurement-select");
  if (sel) {
    sel.addEventListener("change", async () => {
      const idx = parseInt(sel.value, 10);
      const m = g_measurements.find(x => x.index === idx);
      if (m) {
        try { await loadMeasurement(m); }
        catch (err) { setStatus("Load failed: " + err.message, "err"); }
      }
    });
  }

  // Recompute automatically when the spoke count changes (no button needed).
  $("#n-spokes")?.addEventListener("input", () => scheduleCompute());
  $("#flat-dcf")?.addEventListener("change", () => scheduleCompute(0));

  $("#download-mat").addEventListener("click", () => downloadSelectedTrajectory("mat"));
  $("#download-npz").addEventListener("click", () => downloadSelectedTrajectory("npz"));

  $("#download-pro").addEventListener("click", async () => {
    if (!g_file || !g_params?._measurement) return;
    const measurement = g_measurements?.find(item => item.index === g_params._measurement.index);
    if (!measurement) return;
    const button = $("#download-pro");
    button.disabled = true;
    setStatus("Extracting scanner protocol…");
    try {
      const protocol = await extractScannerProtocol(g_file, measurement);
      if (!protocol) throw new Error("No Phoenix/XProtocol or ASCCONV block was found");
      const sourceStem = g_file.name.replace(/\.dat$/i, "");
      const filename = `${safeDownloadStem(sourceStem)}.pro`;
      triggerDownload(new Blob([protocol.bytes], { type: "application/octet-stream" }), filename);
      setStatus(`${protocol.format} scanner protocol downloaded as ${filename}.`, "ok");
    } catch (err) {
      console.error(err);
      setStatus(`Protocol export failed: ${err.message}`, "err");
    } finally {
      button.disabled = false;
    }
  });

  $("#download-json").addEventListener("click", () => {
    if (!g_params) return;
    const copy = { ...g_params };
    delete copy.rot_matrix;
    const blob = new Blob([JSON.stringify(copy, null, 2)], { type: "application/json" });
    triggerDownload(blob, "koreo_params.json");
  });

  // Restore any GIRFs the user previously stored in this browser.
  loadPersistedGirfLibrary();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireUp);
} else {
  wireUp();
}
