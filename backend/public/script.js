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

const LOST_DELAY_SECONDS = 8;
const CONFIDENCE_LIMIT = 0.45;
const LOCK_CONFIRM_SECONDS = 2;

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

const itemLabels = {
  "cell phone": "Handphone",
  "laptop": "Laptop",
  "backpack": "Tas",
  "book": "Buku"
};

const itemClasses = {
  "cell phone": ["cell phone"],
  "laptop": ["laptop"],
  "backpack": ["backpack", "handbag"],
  "book": ["book"]
};

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
  return itemLabels[targetItem] || targetItem;
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

function getTargetPredictions(predictions, targetItem) {
  const allowedClasses = itemClasses[targetItem] || [targetItem];

  return predictions.filter(prediction => {
    return allowedClasses.includes(prediction.class) && prediction.score >= CONFIDENCE_LIMIT;
  });
}

function getBestPrediction(predictions) {
  if (predictions.length === 0) return null;

  return predictions.reduce((best, current) => {
    return current.score > best.score ? current : best;
  });
}

function boxMatchesLockedArea(currentBox, referenceBox) {
  if (!referenceBox) return false;

  const [rx, ry, rw, rh] = referenceBox;
  const [cx, cy, cw, ch] = currentBox;

  const currentCenterX = cx + cw / 2;
  const currentCenterY = cy + ch / 2;

  const expandX = rw * 0.8;
  const expandY = rh * 0.8;

  const insideX =
    currentCenterX >= rx - expandX &&
    currentCenterX <= rx + rw + expandX;

  const insideY =
    currentCenterY >= ry - expandY &&
    currentCenterY <= ry + rh + expandY;

  const referenceArea = rw * rh;
  const currentArea = cw * ch;
  const areaRatio = currentArea / referenceArea;

  const sizeStillSimilar = areaRatio >= 0.25 && areaRatio <= 4;

  return insideX && insideY && sizeStillSimilar;
}

function drawDetections(targetPredictions, matchedPredictions, targetItem) {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const targetLabel = getItemLabel(targetItem);

  // Gambar area barang yang sudah dikunci
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
  const targetItem = targetItemInput.value;

  const data = {
    ownerName: ownerNameInput.value.trim(),
    ownerEmail: ownerEmailInput.value.trim(),
    itemName: getItemLabel(targetItem),
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

  const targetItem = targetItemInput.value;
  const targetLabel = getItemLabel(targetItem);

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
  const targetDetectedButWrongArea = targetPredictions.length > 0 && matchedPredictions.length === 0;

  if (targetDetectedInLockedArea) {
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
  const targetItem = targetItemInput.value;
  const targetLabel = getItemLabel(targetItem);

  if (!ownerName || !ownerEmail || !location) {
    alert("Isi nama pemilik, email pemilik, dan lokasi pemantauan dulu.");
    return;
  }

  if (!ownerEmail.includes("@")) {
    alert("Format email belum benar.");
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