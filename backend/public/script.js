let model = null;
let stream = null;
let isMonitoring = false;
let animationId = null;

let missingStartTime = null;
let alertSent = false;

// State untuk kunci barang berdasarkan posisi awal
let itemLocked = false;
let firstDetectedAt = null;
let lockedBox = null;

// Stabilizer agar deteksi tidak gampang kedip/hilang sesaat
let lastSeenInLockedAreaAt = null;

const LOST_DELAY_SECONDS = 8;
const LOCK_CONFIRM_SECONDS = 2;
const SMOOTH_MISSING_MS = 900;

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const ownerNameInput = document.getElementById("ownerName");
const ownerEmailInput = document.getElementById("ownerEmail");
const targetItemInput = document.getElementById("targetItem");
const locationInput = document.getElementById("location");

const modelStatus = document.getElementById("modelStatus");
const alertBox = document.getElementById("alertBox");
const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");

const itemInfo = document.getElementById("itemInfo");
const detectInfo = document.getElementById("detectInfo");
const missingTime = document.getElementById("missingTime");
const notifStatus = document.getElementById("notifStatus");
const historyList = document.getElementById("historyList");

// Fokus barang untuk demo: Laptop, Handphone, Buku
const TARGET_ITEMS = {
  laptop: {
    label: "Laptop",
    classes: ["laptop"],
    minScore: 0.45,
    minAreaRatio: 0.01
  },
  handphone: {
    label: "Handphone",
    classes: ["cell phone"],
    minScore: 0.25,
    minAreaRatio: 0.001
  },
};

function normalizeTargetItem(value) {
  const target = String(value || "").toLowerCase().trim();

  if (target === "laptop") return "laptop";
  if (target === "handphone" || target === "hp" || target === "phone" || target === "cell phone") return "handphone";

  return null;
}

function getTargetConfig(targetItem) {
  const normalized = normalizeTargetItem(targetItem);
  return normalized ? TARGET_ITEMS[normalized] : null;
}

async function loadModel() {
  try {
    modelStatus.textContent = "Memuat model AI...";
    model = await cocoSsd.load();
    modelStatus.textContent = "Model AI siap";
  } catch (error) {
    console.error(error);
    modelStatus.textContent = "Model gagal dimuat";
  }
}

function getItemLabel(targetItem) {
  const config = getTargetConfig(targetItem);
  return config ? config.label : targetItem;
}

function setStatus(type, title, text) {
  alertBox.className = `alert ${type}`;
  statusTitle.textContent = title;
  statusText.textContent = text;
}

function getCurrentTime() {
  const now = new Date();

  return now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function addHistory(message) {
  if (
    historyList.children.length === 1 &&
    historyList.children[0].textContent.includes("Belum ada")
  ) {
    historyList.innerHTML = "";
  }

  const li = document.createElement("li");
  li.textContent = `[${getCurrentTime()}] ${message}`;
  historyList.prepend(li);
}

function syncCanvasSize() {
  if (!video.videoWidth || !video.videoHeight) return;

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  video.srcObject = stream;

  return new Promise((resolve) => {
    video.onloadedmetadata = async () => {
      await video.play();
      syncCanvasSize();
      resolve();
    };
  });
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function getBoxArea(box) {
  if (!box) return 0;
  return box[2] * box[3];
}

function getFrameArea() {
  const width = canvas.width || video.videoWidth || 1;
  const height = canvas.height || video.videoHeight || 1;
  return width * height;
}

function getTargetPredictions(predictions, targetItem) {
  const config = getTargetConfig(targetItem);

  if (!config) return [];

  const frameArea = getFrameArea();

  return predictions
    .filter(prediction => {
      const boxArea = getBoxArea(prediction.bbox);
      const areaRatio = boxArea / frameArea;

      return (
        config.classes.includes(prediction.class) &&
        prediction.score >= config.minScore &&
        areaRatio >= config.minAreaRatio
      );
    })
    .sort((a, b) => b.score - a.score);
}

function getBestPrediction(predictions) {
  if (predictions.length === 0) return null;

  const frameArea = getFrameArea();

  return predictions.reduce((best, current) => {
    const bestAreaRatio = getBoxArea(best.bbox) / frameArea;
    const currentAreaRatio = getBoxArea(current.bbox) / frameArea;

    const bestValue = best.score + Math.min(bestAreaRatio * 2, 0.25);
    const currentValue = current.score + Math.min(currentAreaRatio * 2, 0.25);

    return currentValue > bestValue ? current : best;
  });
}

function getIoU(boxA, boxB) {
  if (!boxA || !boxB) return 0;

  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;

  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);

  const intersectionWidth = Math.max(0, x2 - x1);
  const intersectionHeight = Math.max(0, y2 - y1);
  const intersectionArea = intersectionWidth * intersectionHeight;

  const areaA = aw * ah;
  const areaB = bw * bh;
  const unionArea = areaA + areaB - intersectionArea;

  if (unionArea <= 0) return 0;

  return intersectionArea / unionArea;
}

function boxMatchesLockedArea(currentBox, referenceBox) {
  if (!referenceBox || !currentBox) return false;

  const [rx, ry, rw, rh] = referenceBox;
  const [cx, cy, cw, ch] = currentBox;

  const currentCenterX = cx + cw / 2;
  const currentCenterY = cy + ch / 2;

  const referenceCenterX = rx + rw / 2;
  const referenceCenterY = ry + rh / 2;

  const distanceX = Math.abs(currentCenterX - referenceCenterX);
  const distanceY = Math.abs(currentCenterY - referenceCenterY);

  const centerStillClose =
    distanceX <= rw * 1.15 &&
    distanceY <= rh * 1.15;

  const referenceArea = rw * rh;
  const currentArea = cw * ch;
  const areaRatio = currentArea / referenceArea;

  const sizeStillSimilar = areaRatio >= 0.20 && areaRatio <= 5;

  const iou = getIoU(currentBox, referenceBox);
  const stillOverlaps = iou >= 0.06;

  return sizeStillSimilar && (centerStillClose || stillOverlaps);
}

function blendBox(oldBox, newBox, alpha = 0.05) {
  if (!oldBox) return newBox;
  if (!newBox) return oldBox;

  return oldBox.map((value, index) => {
    return value * (1 - alpha) + newBox[index] * alpha;
  });
}

function drawDetections(targetPredictions, matchedPredictions, targetItem) {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const targetLabel = getItemLabel(targetItem);

  if (lockedBox) {
    const [x, y, width, height] = lockedBox;

    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);

    ctx.setLineDash([]);
    ctx.fillStyle = "#facc15";
    ctx.font = "16px Arial";
    ctx.fillText("Area barang tersimpan", x, y > 20 ? y - 8 : y + 20);
  }

  targetPredictions.forEach(prediction => {
    const [x, y, width, height] = prediction.bbox;

    const isMatched = matchedPredictions.includes(prediction);
    const isWrongArea = itemLocked && !isMatched;

    ctx.strokeStyle = isWrongArea ? "#f97316" : "#22c55e";
    ctx.fillStyle = isWrongArea ? "#f97316" : "#22c55e";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);

    ctx.font = "16px Arial";

    const label = isWrongArea
      ? `${targetLabel} di luar area`
      : `${targetLabel} ${(prediction.score * 100).toFixed(0)}%`;

    ctx.fillText(label, x, y > 20 ? y - 8 : y + 20);
  });
}

async function sendLostItemNotification() {
  const targetItem = normalizeTargetItem(targetItemInput.value);
  const targetLabel = getItemLabel(targetItem);

  const data = {
    ownerName: ownerNameInput.value.trim(),
    ownerEmail: ownerEmailInput.value.trim(),
    itemName: targetLabel,
    itemClass: targetItem,
    location: locationInput.value.trim(),
    time: getCurrentTime()
  };

  notifStatus.textContent = "Mengirim email...";

  try {
    const response = await fetch("/api/lost-item", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Backend gagal menerima laporan");
    }

    console.log("DATA YANG DIKIRIM KE BACKEND:", data);
    console.log("RESPON BACKEND:", result);

    const status = result.data?.notificationStatus || "EMAIL_GAGAL";
    const message = result.data?.notificationMessage || "";

    if (status === "EMAIL_TERKIRIM") {
      notifStatus.textContent = "Email terkirim";
    } else if (status === "EMAIL_GAGAL") {
      notifStatus.textContent = "Email gagal";
      console.log("ALASAN EMAIL GAGAL:", message);
    } else {
      notifStatus.textContent = status;
    }

    addHistory(
      `${data.itemName} hilang di ${data.location}. Status notifikasi: ${notifStatus.textContent}.`
    );

  } catch (error) {
    console.warn(error.message);

    notifStatus.textContent = "Backend gagal";
    addHistory(
      `${data.itemName} hilang di ${data.location}. Backend gagal menerima laporan atau email belum terkirim.`
    );
  }
}

async function detectLoop() {
  if (!isMonitoring || !model) return;

  if (video.readyState < 2) {
    animationId = requestAnimationFrame(detectLoop);
    return;
  }

  syncCanvasSize();

  const targetItem = normalizeTargetItem(targetItemInput.value);
  const targetLabel = getItemLabel(targetItem);

  if (!targetItem) {
    setStatus(
      "danger",
      "Barang Tidak Didukung",
      "Barang yang dipilih tidak didukung. Gunakan Laptop atau Handphone."
    );
    isMonitoring = false;
    stopCamera();
    return;
  }

  const predictions = await model.detect(video);

  const targetPredictions = getTargetPredictions(predictions, targetItem);
  const bestTarget = getBestPrediction(targetPredictions);
  const targetDetected = targetPredictions.length > 0;

  // TAHAP 1: Cari dan simpan posisi awal barang
  if (!itemLocked) {
    missingStartTime = null;
    missingTime.textContent = "-";
    notifStatus.textContent = "Belum dikirim";

    drawDetections(targetPredictions, targetPredictions, targetItem);

    if (targetDetected && bestTarget) {
      if (!firstDetectedAt) {
        firstDetectedAt = Date.now();
      }

      const lockSeconds = Math.floor((Date.now() - firstDetectedAt) / 1000);

      detectInfo.textContent = `Target terlihat (${targetPredictions.length})`;

      setStatus(
        "warning",
        "Menyimpan Barang Target",
        `${targetLabel} terdeteksi. Sistem sedang menyimpan posisi awal selama ${lockSeconds}/${LOCK_CONFIRM_SECONDS} detik.`
      );

      if (lockSeconds >= LOCK_CONFIRM_SECONDS) {
        itemLocked = true;
        lockedBox = bestTarget.bbox;
        firstDetectedAt = null;
        lastSeenInLockedAreaAt = Date.now();

        detectInfo.textContent = "Barang tersimpan";
        missingTime.textContent = "0 detik";

        setStatus(
          "safe",
          "Barang Tersimpan",
          `${targetLabel} berhasil disimpan berdasarkan posisi awal. Pemantauan kehilangan sekarang aktif.`
        );

        addHistory(
          `${targetLabel} berhasil disimpan berdasarkan posisi awal. Sistem mulai memantau kehilangan.`
        );
      }

    } else {
      firstDetectedAt = null;
      detectInfo.textContent = "Mencari target";

      setStatus(
        "warning",
        "Mencari Barang Target",
        `Arahkan kamera ke ${targetLabel}. Sistem belum menghitung kehilangan sebelum barang target tersimpan.`
      );
    }

    animationId = requestAnimationFrame(detectLoop);
    return;
  }

  // TAHAP 2: Setelah barang tersimpan, hanya objek di area awal yang dianggap aman
  const matchedPredictions = targetPredictions.filter(prediction => {
    return boxMatchesLockedArea(prediction.bbox, lockedBox);
  });

  drawDetections(targetPredictions, matchedPredictions, targetItem);

  const targetDetectedInLockedArea = matchedPredictions.length > 0;
  const targetDetectedButWrongArea =
    targetPredictions.length > 0 && matchedPredictions.length === 0;

  if (targetDetectedInLockedArea) {
    const bestMatch = getBestPrediction(matchedPredictions);

    if (bestMatch) {
      lockedBox = blendBox(lockedBox, bestMatch.bbox, 0.04);
    }

    lastSeenInLockedAreaAt = Date.now();
    missingStartTime = null;

    detectInfo.textContent = `Terdeteksi di area awal (${matchedPredictions.length})`;
    missingTime.textContent = "0 detik";

    if (!alertSent) {
      notifStatus.textContent = "Belum dikirim";
    }

    setStatus(
      "safe",
      "Barang Aman",
      `${targetLabel} masih terdeteksi di posisi awal pemantauan.`
    );

  } else {
    const stillInSmoothTime =
      lastSeenInLockedAreaAt &&
      Date.now() - lastSeenInLockedAreaAt <= SMOOTH_MISSING_MS;

    if (stillInSmoothTime) {
      detectInfo.textContent = "Menstabilkan deteksi...";
      missingTime.textContent = "0 detik";

      setStatus(
        "safe",
        "Barang Aman",
        `${targetLabel} masih dianggap aman. Sistem sedang menstabilkan deteksi kamera.`
      );

      animationId = requestAnimationFrame(detectLoop);
      return;
    }

    if (!missingStartTime) {
      missingStartTime = Date.now();
    }

    const elapsedSeconds = Math.floor((Date.now() - missingStartTime) / 1000);
    missingTime.textContent = `${elapsedSeconds} detik`;

    if (targetDetectedButWrongArea) {
      detectInfo.textContent = "Terdeteksi di luar area awal";

      if (elapsedSeconds < LOST_DELAY_SECONDS) {
        setStatus(
          "warning",
          "Barang Tidak Sesuai Posisi Awal",
          `${targetLabel} terdeteksi, tetapi bukan di area awal yang tersimpan. Sistem tetap menghitung kemungkinan kehilangan.`
        );
      }
    } else {
      detectInfo.textContent = "Tidak terlihat";

      if (elapsedSeconds < LOST_DELAY_SECONDS) {
        setStatus(
          "warning",
          "Barang Tidak Terlihat",
          `${targetLabel} belum terlihat selama ${elapsedSeconds} detik dari area awal. Sistem sedang memastikan kondisi barang.`
        );
      }
    }

    if (elapsedSeconds >= LOST_DELAY_SECONDS) {
      setStatus(
        "danger",
        "Barang Terdeteksi Hilang",
        `${targetLabel} tidak terlihat di area awal lebih dari ${LOST_DELAY_SECONDS} detik. Sistem mengirim peringatan email ke pemilik barang.`
      );

      if (!alertSent) {
        alertSent = true;
        await sendLostItemNotification();
      }
    }
  }

  animationId = requestAnimationFrame(detectLoop);
}

startBtn.addEventListener("click", async () => {
  const ownerName = ownerNameInput.value.trim();
  const ownerEmail = ownerEmailInput.value.trim();
  const location = locationInput.value.trim();
  const targetItem = normalizeTargetItem(targetItemInput.value);
  const targetLabel = getItemLabel(targetItem);

  if (!ownerName || !ownerEmail || !location) {
    alert("Isi nama pemilik, email pemilik, dan lokasi pemantauan dulu.");
    return;
  }

  if (!ownerEmail.includes("@")) {
    alert("Format email belum benar.");
    return;
  }

  if (!targetItem) {
    alert("Barang yang dipilih tidak didukung. Gunakan Laptop, Handphone, atau Buku.");
    return;
  }

  if (!model) {
    alert("Model AI belum siap. Tunggu sebentar lalu coba lagi.");
    return;
  }

  try {
    isMonitoring = true;
    missingStartTime = null;
    alertSent = false;

    itemLocked = false;
    firstDetectedAt = null;
    lockedBox = null;
    lastSeenInLockedAreaAt = null;

    itemInfo.textContent = targetLabel;
    detectInfo.textContent = "Mencari target...";
    missingTime.textContent = "-";
    notifStatus.textContent = "Belum dikirim";

    setStatus(
      "warning",
      "Mencari Barang Target",
      `Arahkan kamera ke ${targetLabel}. Sistem akan menyimpan posisi awal barang terlebih dahulu.`
    );

    await startCamera();

    addHistory(
      `Pemantauan dimulai untuk ${targetLabel} milik ${ownerName}. Sistem akan menyimpan posisi awal barang.`
    );

    detectLoop();
  } catch (error) {
    console.error(error);
    isMonitoring = false;

    setStatus(
      "danger",
      "Kamera Gagal Dibuka",
      "Pastikan browser sudah mendapat izin kamera dan gunakan HTTPS atau localhost."
    );
  }
});

stopBtn.addEventListener("click", () => {
  isMonitoring = false;
  stopCamera();

  itemLocked = false;
  firstDetectedAt = null;
  lockedBox = null;
  lastSeenInLockedAreaAt = null;
  missingStartTime = null;

  setStatus(
    "safe",
    "Pemantauan Berhenti",
    "Sistem sudah berhenti memantau barang."
  );

  detectInfo.textContent = "-";
  missingTime.textContent = "0 detik";

  addHistory("Pemantauan dihentikan.");
});

window.addEventListener("resize", () => {
  setTimeout(syncCanvasSize, 250);
});

window.addEventListener("orientationchange", () => {
  setTimeout(syncCanvasSize, 500);
});

loadModel();