// It all starts with a context
const context = new AudioContext({ samplerate: 48000 });

const samplerate = context.sampleRate;

// Buffer sizes
const BUFFER_SIZE = 1024; // the chunks we get from the input source (e.g. the mic)
const FRAME_SIZE = samplerate * 0.025; // Frame_time == 25 ms
const FRAME_STRIDE = samplerate * 0.01; // Frame_stride == 10 ms (=> 15 ms overlap)

// ASR
const buffertime = 1; // in seconds
const RECORD_SIZE = Math.floor((samplerate * buffertime) / BUFFER_SIZE) * BUFFER_SIZE; // ~buffertime in number of samples, ensure integer fraction size of concat

// Ringbuffer Time Domain (1D)
const RB_SIZE = 2 * RECORD_SIZE; // arbitrary choice, shall be gt RECORD_SIZE and integer fraction of BUFFER_SIZE
const timeDomainData = new CircularBuffer(RB_SIZE);

// RingBuffer Framing (2D)
const RB_SIZE_FRAMING = utils.getNumberOfFrames(RB_SIZE, FRAME_SIZE, FRAME_STRIDE); // how many frames with overlap fit into time domain ringbuffer
const RECORD_SIZE_FRAMING = utils.getNumberOfFrames(RECORD_SIZE, FRAME_SIZE, FRAME_STRIDE); // number of frames in record
let Data_Pos = 0; // head position
const DFT_Data = []; // after fourier transform [B2P1][RB_SIZE_FRAMING]
const LOG_MEL_RAW = []; // log mel filter coefficients
const LOG_MEL = []; // log mel filter coefficients after some scaling for visualization

// Hamming Window
const fenster = createWindowing(FRAME_SIZE); // don't call it window ...

// DFT
const fft = createFFT(FRAME_SIZE);
const B2P1 = FRAME_SIZE / 2 + 1; // Length of frequency domain data

// Mel Filter
const N_MEL_FILTER = 40; // Number of Mel Filterbanks (power of 2 for DCT)
const filter = mel_filter();
const MIN_FREQUENCY = 300; // lower end of first mel filter bank
// TODO: if we cut off frequencies above 8 kHz, we may save some mips if we downsample e.g. to 16 kHz before (low pass and taking every third sample if we have 48 kHz)
const MAX_FREQUENCY = 8000; // upper end of last mel filterbank
filter.init(samplerate, FRAME_SIZE, MIN_FREQUENCY, MAX_FREQUENCY, N_MEL_FILTER);

// VAD - https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6150492/
// I want to get an quadratic image, thus
const VAD_SIZE = N_MEL_FILTER;
const VAD_TIME = utils.getSizeOfBuffer(N_MEL_FILTER, FRAME_SIZE, FRAME_STRIDE) / samplerate;
const VAD_IMG = [];
const VAD_RESULT = []; // result of VAD
const VAD_THRESHOLD = -1; //0.7;
const TRESHOLD = 0.9;
const VAD_N_SNAPSHOTS = 10;
const VAD_OVERLAP = 0.5;
let VAD_LAST_POS = 0;
let VAD_AVERAGE = 0;

// Datasets
const NCLASSES = 4; // How many classes to classify (normally, the first class refers to the background)
const dataset = createDataset(NCLASSES, undefined, undefined, 0.2); // validation split
const dataset_vad = createDataset(2, VAD_SIZE, N_MEL_FILTER, 0.2); // validation split
let trained_data = undefined;
let trained_data_vad = undefined;
let is_trained = false;
let is_trained_vad = false;

// Data augmentation
const N_AUG = 4;
const FRACTION = 0.25; // horizontal shift fraction
const opt = { fill_mode: 'nearest' };
const generator = createImageDataGenerator(opt);

// Neural Network
let nn; // defined later
let model;
const nn_vad = createNetwork_VAD(N_MEL_FILTER, N_MEL_FILTER, 2);
let model_vad;
const MEAN_NORMALIZE = true; // false -> standardize
const PRED_IMG = [];
// no vad -> about 500 ms
// with vad -> VAD_TIME ?
//console.log(VAD_TIME);
const PRED_INTERVALL = 250;
const PRED_SUSPEND = 4;
let suspend = 1;

//console.log(samplerate, BUFFER_SIZE, FRAME_SIZE, FRAME_STRIDE, RB_SIZE, RB_SIZE_FRAMING, N_DCT, RECORD_SIZE);

// Plotting
const ANIM_INTERVALL = 100;
let STARTFRAME; // Recording Startframe (used for drawing)
let ENDFRAME; // Recording Endframe (used for drawing)
const MIN_EXP = -1; // 10^{min_exp} linear, log scale minimum
const MAX_EXP = 3; // 10^{max_exp} linear, log scale max

// Prefill arrays
for (let idx = 0; idx < RB_SIZE_FRAMING; idx++) {
  let ft_array = Array.from(Array(B2P1), () => 0);
  DFT_Data.push(ft_array);

  let mel_raw_array = Array.from(Array(N_MEL_FILTER), () => 0);
  LOG_MEL_RAW.push(mel_raw_array);

  let mel_array = Array.from(Array(N_MEL_FILTER), () => 255);
  LOG_MEL.push(mel_array);

  VAD_RESULT.push(0);
}

for (let idx = 0; idx < RECORD_SIZE_FRAMING; idx++) {
  let pred_array = Array.from(Array(N_MEL_FILTER), () => 255);
  PRED_IMG.push(pred_array);
}

for (let idx = 0; idx < VAD_SIZE; idx++) {
  let vad_array = Array.from(Array(N_MEL_FILTER), () => 255);
  VAD_IMG.push(vad_array);
}

// Canvas width and height
let drawit = [false, false, true, true, true];
let canvas;
let canvasCtx;
let canvas_fftSeries;
let context_fftSeries;
let canvas_fftSeries_mel;
let context_fftSeries_mel;
let canvas_fftSeries_pred;
let context_fftSeries_pred;
let canvas_vad_meter;
let context_vad_meter;
let canvas_pred_meter = [];
let context_pred_meter = [];
(function create_some_stuff() {
  if (drawit[0]) {
    canvas = document.getElementById('oscilloscope');
    canvasCtx = canvas.getContext('2d');
    canvas.width = 2 * RB_SIZE_FRAMING;
    canvas.height = 100; //B2P1;
  }

  if (drawit[1]) {
    canvas_fftSeries = document.getElementById('fft-series');
    context_fftSeries = canvas_fftSeries.getContext('2d');
    canvas_fftSeries.width = 2 * RB_SIZE_FRAMING;
    canvas_fftSeries.height = B2P1;
  }

  if (drawit[2]) {
    canvas_fftSeries_mel = document.getElementById('fft-series mel');
    context_fftSeries_mel = canvas_fftSeries_mel.getContext('2d');
    canvas_fftSeries_mel.width = 4 * RB_SIZE_FRAMING;
    canvas_fftSeries_mel.height = 4 * N_MEL_FILTER;
  }

  if (drawit[3]) {
    canvas_fftSeries_pred = document.getElementById('fft-series pred');
    context_fftSeries_pred = canvas_fftSeries_pred.getContext('2d');
    canvas_fftSeries_pred.width = 4 * RB_SIZE_FRAMING;
    canvas_fftSeries_pred.height = 4 * N_MEL_FILTER;

  }

  if (drawit[4]) {
    canvas_vad_meter = document.getElementById('vad meter');
    context_vad_meter = canvas_vad_meter.getContext('2d');
    canvas_vad_meter.width = canvas_fftSeries_pred.width;
    canvas_vad_meter.height = 40;

    //create pred canvas dynamically
    const container = document.getElementById('pred meter container');
    for (let classIdx = 0; classIdx < NCLASSES; classIdx++) {

      let canvas = document.createElement('canvas');
      canvas.width = 4 * RB_SIZE_FRAMING;
      canvas.height = 40;
      canvas.id = `pred class${classIdx + 1}`;
      const label = document.createElement('label');
      label.innerHTML = `class${classIdx + 1}`;
      label.htmlFor = `pred class${classIdx + 1}`;
      let context = canvas.getContext('2d');
      container.appendChild(label);
      container.appendChild(canvas);
      container.appendChild(document.createElement('br'))
      canvas_pred_meter.push(canvas);
      context_pred_meter.push(context);
    }
  }
})();

/**
 * Handle mic data
 */
const handleSuccess = function (stream) {
  console.log('handle success');
  const source = context.createMediaStreamSource(stream);

  // Create a ScriptProcessorNode
  const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
  source.connect(processor);
  processor.connect(context.destination);

  processor.onaudioprocess = function (e) {
    const inputBuffer = e.inputBuffer;
    timeDomainData.concat(inputBuffer.getChannelData(0));

    doFraming();
    doVAD();

    // Clear frames (for drawing start and end of vertical line when recording)
    if (STARTFRAME == Data_Pos) {
      STARTFRAME = undefined;
    }
    if (ENDFRAME == Data_Pos) {
      ENDFRAME = undefined;
    }
  }; //end onprocess mic data
};

/** Kicks off Mic data handle function
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
 */
navigator.mediaDevices
  .getUserMedia({ audio: true, video: false })
  .then(handleSuccess)
  .catch((err) => console.log(err));

let nextStartPos = 0;
function doFraming() {
  let headPos = timeDomainData.getHeadPos();
  let availableData = headPos - nextStartPos;
  if (availableData < 0) {
    availableData = headPos + timeDomainData.getLength() - nextStartPos;
  }

  if (availableData < FRAME_SIZE) {
    return;
  }

  let nFrames = utils.getNumberOfFrames(availableData, FRAME_SIZE, FRAME_STRIDE);
  let startPos = nextStartPos;
  let endPos = (nextStartPos + FRAME_SIZE) % RB_SIZE;

  for (let idx = 0; idx < nFrames; idx++) {
    let frame_buffer = timeDomainData.getSlice(startPos, endPos);

    // Windowing
    fenster.hamming(frame_buffer);

    // Fourier Transform
    const mag = fft.getPowerspectrum(frame_buffer);
    DFT_Data[Data_Pos] = utils.logRangeMapBuffer(mag, MIN_EXP, MAX_EXP, 255, 0);

    // MelFilter;
    let mel_array = filter.getLogMelCoefficients(mag);
    //LOG_MEL_RAW[Data_Pos] = Array.from(mel_array);
    LOG_MEL_RAW[Data_Pos] = mel_array;
    LOG_MEL[Data_Pos] = utils.rangeMapBuffer(mel_array, MIN_EXP, MAX_EXP, 255, 0);

    // Bookeeping
    Data_Pos = (Data_Pos + 1) % RB_SIZE_FRAMING;
    startPos = (startPos + FRAME_STRIDE) % RB_SIZE;
    endPos = (endPos + FRAME_STRIDE) % RB_SIZE;
  }

  nextStartPos = startPos;
}

let vad_prevEndPos = 0;
let vad_nextStartPos = 0;
function doVAD() {
  // check if you have enough data for VAD
  let availableData = Data_Pos - vad_nextStartPos;

  if (availableData < 0) {
    availableData = Data_Pos + RB_SIZE_FRAMING - vad_nextStartPos;
  }

  if (availableData < VAD_SIZE) {
    return;
  }

  let curpos = vad_nextStartPos;
  let endPos = (vad_nextStartPos + VAD_SIZE) % RB_SIZE_FRAMING;

  //console.log('a', vad_nextStartPos, endPos, vad_prevEndPos);

  // copy image
  for (let idx = 0; idx < RB_SIZE_FRAMING; idx++) {
    VAD_IMG[idx] = Array.from(LOG_MEL_RAW[curpos]);

    curpos++;
    if (curpos >= RB_SIZE_FRAMING) {
      curpos = 0;
    }
    if (curpos == endPos) {
      break;
    }
  }

  if (MEAN_NORMALIZE) {
    utils.meanNormalize(VAD_IMG);
  } else {
    utils.standardize(VAD_IMG);
  }

  // make vad prediction and fill result
  // do some averaging when overlapping (does not look very efficient though)
  // and ... do it sychronously !!! otherwise the variables may get alterd after this fcn
  curpos = vad_nextStartPos;
  if (model_vad != undefined) {
    tf.tidy(() => {
      //get voice activity in current frame
      let x = tf.tensor2d(VAD_IMG).reshape([1, VAD_SIZE, N_MEL_FILTER, 1]);

      const res = model_vad.predict(x);
      const result = res.dataSync();

      // console.log('b', vad_nextStartPos, endPos, vad_prevEndPos);

      let hit = false;
      for (let idx = 0; idx < RB_SIZE_FRAMING; idx++) {
        if (curpos == vad_prevEndPos) {
          hit = true;
        }
        if (!hit) {
          VAD_RESULT[curpos] = (VAD_RESULT[curpos] + result[1]) / 2;
        } else {
          VAD_RESULT[curpos] = result[1];
        }

        curpos++;
        if (curpos >= RB_SIZE_FRAMING) {
          curpos = 0;
        }
        if (curpos == endPos) {
          break;
        }
        // do it in here :)
        vad_prevEndPos = endPos;
      }
    });
  }

  // last
  VAD_LAST_POS = vad_nextStartPos + VAD_SIZE;
  // new pos with some overlap
  vad_nextStartPos = Math.round(vad_nextStartPos + (1 - VAD_OVERLAP) * VAD_SIZE);

  vad_nextStartPos = vad_nextStartPos % RB_SIZE_FRAMING;
  VAD_LAST_POS = VAD_LAST_POS % RB_SIZE_FRAMING;

  averageVAD(Data_Pos);

  //console.log(VAD_AVERAGE);
}

/** 
 * average VAD over the record size
 */
function averageVAD(endPos) {
  // some averaging
  let startFrame = endPos - RECORD_SIZE_FRAMING;
  if (startFrame < 0) {
    startFrame = RB_SIZE_FRAMING + startFrame;
  }

  // check for voice activity
  let curpos = startFrame;
  let size = 0;
  // likely that the last vad is not yet calculated
  for (let idx = 0; idx < RECORD_SIZE_FRAMING; idx++) {
    VAD_AVERAGE += VAD_RESULT[curpos];
    curpos++;
    size++;
    if (curpos >= RB_SIZE_FRAMING) {
      curpos = 0;
    }
    if (curpos == VAD_LAST_POS) {
      break;
    }
  }
  VAD_AVERAGE /= size;
}

/**
 * Recursive draw function
 * Called as fast as possible by the browser (as far as I understood)
 * Why not making an IIFE ...
 */
const draw = function () {
  let barWidth;
  let barHeight;
  let mag = 0;
  let x = 0;

  // Draw magnitudes
  if (drawit[0]) {
    barWidth = canvas.width / B2P1;
    canvasCtx.fillStyle = '#FFF';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < B2P1; i++) {
      mag = DFT_Data[Data_Pos][i];
      mag = Math.round(mag);
      barHeight = -canvas.height + utils.map(mag, 0, 255, 0, canvas.height);
      canvasCtx.fillStyle = utils.rainbow[mag];
      canvasCtx.fillRect(x, canvas.height, barWidth, barHeight);
      x += barWidth;
    }
    canvasCtx.strokeRect(0, 0, canvas.width, canvas.height);

    // Draw time series on top
    canvasCtx.beginPath();
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = '#000099';
    let sliceWidth = canvas.width / BUFFER_SIZE;
    x = 0;
    let timearray = timeDomainData.getSlice(timeDomainData.lastHead, timeDomainData.head);
    for (let i = 0; i < BUFFER_SIZE; i++) {
      let v = timearray[i] + 1;
      let y = (v * canvas.height) / 2;
      if (i === 0) {
        canvasCtx.moveTo(x, y);
      } else {
        canvasCtx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    //canvasCtx.lineTo(canvas.width, canvas.height / 2);
    canvasCtx.stroke();
  }

  // Draw FT Time Series
  if (drawit[1]) {
    context_fftSeries.fillStyle = '#FFF';
    context_fftSeries.fillRect(0, 0, canvas_fftSeries.width, canvas_fftSeries.height);

    let rectHeight = canvas_fftSeries.height / B2P1;
    let rectWidth = canvas_fftSeries.width / RB_SIZE_FRAMING;
    let xpos = 0;
    let ypos;
    for (let xidx = Data_Pos + 1; xidx <= Data_Pos + RB_SIZE_FRAMING; xidx++) {
      ypos = canvas_fftSeries.height;
      for (let yidx = 0; yidx < B2P1; yidx++) {
        mag = DFT_Data[xidx % RB_SIZE_FRAMING][yidx];
        mag = Math.round(mag);
        if (mag != 0) {
          context_fftSeries.fillStyle = utils.rainbow[mag];
          context_fftSeries.fillRect(xpos, ypos, rectWidth, -rectHeight);
        } else {
          //
        }
        ypos -= rectHeight;
      }
      xpos += rectWidth;
    }
    context_fftSeries.strokeRect(0, 0, canvas_fftSeries.width, canvas_fftSeries.height);
  }

  // Draw mel spectrum
  if (drawit[2]) {
    context_fftSeries_mel.fillStyle = '#FFF';
    context_fftSeries_mel.fillRect(0, 0, canvas_fftSeries_mel.width, canvas_fftSeries_mel.height);

    rectHeight = canvas_fftSeries_mel.height / N_MEL_FILTER;
    rectWidth = canvas_fftSeries_mel.width / RB_SIZE_FRAMING;
    let xpos = 0;
    for (let xidx = Data_Pos; xidx < Data_Pos + RB_SIZE_FRAMING; xidx++) {
      ypos = canvas_fftSeries_mel.height;
      for (let yidx = 0; yidx < N_MEL_FILTER; yidx++) {
        mag = LOG_MEL[xidx % RB_SIZE_FRAMING][yidx];
        mag = Math.round(mag);
        if (xidx % RB_SIZE_FRAMING == STARTFRAME || xidx % RB_SIZE_FRAMING == ENDFRAME) {
          context_fftSeries_mel.fillStyle = '#800000';
        } else {
          context_fftSeries_mel.fillStyle = utils.rainbow[mag];
        }
        context_fftSeries_mel.fillRect(xpos, ypos, rectWidth, -rectHeight);
        ypos -= rectHeight;
      }
      xpos += rectWidth;
    }

    context_fftSeries_mel.strokeRect(0, 0, canvas_fftSeries_mel.width, canvas_fftSeries_mel.height);

    // Draw VAD on top
    context_fftSeries_mel.beginPath();
    context_fftSeries_mel.lineWidth = 3;
    context_fftSeries_mel.strokeStyle = '#990000';
    let sliceWidth = canvas_fftSeries_mel.width / RB_SIZE_FRAMING;
    xpos = 0;
    //let timearray = timeDomainData.getSlice(timeDomainData.lastHead, timeDomainData.head);
    for (let xidx = Data_Pos; xidx < Data_Pos + RB_SIZE_FRAMING; xidx++) {
      if (xidx % RB_SIZE_FRAMING == VAD_LAST_POS) {
        break;
      }

      let v = 1 - VAD_RESULT[xidx % RB_SIZE_FRAMING];
      //console.log(v);
      let y = v * canvas_fftSeries_mel.height;
      if (xidx === Data_Pos) {
        context_fftSeries_mel.moveTo(xpos, y);
      } else {
        context_fftSeries_mel.lineTo(xpos, y);
      }
      xpos += sliceWidth;
    }
    context_fftSeries_mel.stroke();
  }

  // Draw Pred image
  if (drawit[3]) {
    context_fftSeries_pred.fillStyle = '#FFF';
    context_fftSeries_pred.fillRect(0, 0, canvas_fftSeries_pred.width, canvas_fftSeries_pred.height);

    rectHeight = canvas_fftSeries_pred.height / N_MEL_FILTER;
    rectWidth = canvas_fftSeries_pred.width / RB_SIZE_FRAMING;
    let xpos = (PRED_IMG.length + 2) * rectWidth; // magic

    for (let xidx = 0; xidx < PRED_IMG.length; xidx++) {
      ypos = canvas_fftSeries_pred.height;
      for (let yidx = 0; yidx < N_MEL_FILTER; yidx++) {
        mag = PRED_IMG[xidx][yidx];
        mag = Math.round(mag);
        context_fftSeries_pred.fillStyle = utils.rainbow[mag];
        context_fftSeries_pred.fillRect(xpos, ypos, rectWidth, -rectHeight);
        ypos -= rectHeight;
      }
      xpos += rectWidth;
    }

    context_fftSeries_pred.strokeRect(
      (PRED_IMG.length + 2) * rectWidth,
      0,
      canvas_fftSeries_pred.width,
      canvas_fftSeries_pred.height
    );
  }

  // VAD Meter
  if (drawit[4]) {
    const rectHeight = canvas_vad_meter.height;
    const rectWidth = canvas_vad_meter.width;
    context_vad_meter.clearRect(0, 0, rectWidth, rectHeight);
    if (VAD_AVERAGE > VAD_THRESHOLD) {
      context_vad_meter.fillStyle = "red";
    } else {
      context_vad_meter.fillStyle = "green";
    }
    context_vad_meter.fillRect(0, 0, VAD_AVERAGE * rectWidth, rectHeight);
  }

  // draw asap ... but wait some time to get other things done
  setTimeout(() => {
    requestAnimationFrame(draw);
  }, ANIM_INTERVALL);
}; // end draw fcn

draw();

// Create record buttons for classification
const record_btns_div = document.getElementById('record_btns');
for (let idx = 0; idx < NCLASSES; idx++) {
  const btn = document.createElement('button');
  btn.classList.add('record_btn');
  btn.id = `class${idx + 1}`;
  btn.innerHTML = `Record class${idx + 1}`;
  const label = document.createElement('label');
  label.htmlFor = `class${idx + 1}`;
  record_btns_div.appendChild(btn);
  record_btns_div.appendChild(label);
}

// Create record buttons for vad
const record_btns_vad_div = document.getElementById('record_btns_vad');
const N_VAD_CLASSES = 2;
for (let idx = 0; idx < N_VAD_CLASSES; idx++) {
  const btn = document.createElement('button');
  btn.classList.add('record_btn_vad');
  btn.id = `vad class${idx + 1}`;
  btn.innerHTML = `Record VAD class${idx + 1}`;
  const label = document.createElement('label');
  label.htmlFor = `vad class${idx + 1}`;
  record_btns_vad_div.appendChild(btn);
  record_btns_vad_div.appendChild(label);
}

/**
 * Get collection of buttons for classification
 */
const record_btns_vad = document.getElementsByClassName('record_btn_vad');
const record_btns = document.getElementsByClassName('record_btn');
const train_btn = document.getElementById('train_btn');
const predict_btn = document.getElementById('predict_btn');
const showImages_btn = document.getElementById('showImages_btn');
toggleButtons(false);

/**
 * extract snapshot of RECORDTIME from raw mel ringbuffer
 */
function record(e, label) {
  //let endFrame = SERIES_POS;
  ENDFRAME = (STARTFRAME + RECORD_SIZE_FRAMING) % RB_SIZE_FRAMING;
  let image = [];
  let curpos = STARTFRAME;

  for (let idx = 0; idx < RECORD_SIZE_FRAMING; idx++) {
    image[idx] = Array.from(LOG_MEL_RAW[curpos]);

    curpos++;
    if (curpos >= RB_SIZE_FRAMING) {
      curpos = 0;
    }
    if (curpos == ENDFRAME) {
      break;
    }
  }

  if (MEAN_NORMALIZE) {
    utils.meanNormalize(image);
  } else {
    utils.standardize(image);
  }

  dataset.addImage(image, label);

  for (let idx = 0; idx < N_AUG; idx++) {
    let augImg = generator.horizontalShift(image, FRACTION);
    dataset.addImage(augImg, label);
  }

  e.target.labels[0].innerHTML = `${dataset.getNumImages(label)}`;
  console.log('recording finished');
  toggleButtons(false);
} // end recording

// Event listeners for record buttons
for (let idx = 0; idx < record_btns.length; idx++) {
  record_btns[idx].addEventListener('click', (e) => {
    toggleButtons(true);
    let label = record_btns[idx].id;
    console.log('record:', label);
    STARTFRAME = Data_Pos;
    ENDFRAME = undefined;
    setTimeout(() => {
      record(e, label);
    }, buffertime * 1000); //Fuck ... not always the same length (but always larger :))
  });
}

/**
 * extract snapshots of about RECORDTIME from raw mel ringbuffer
 * ... well take a number of snapshots
 */
function record_vad(e, label) {
  //let endFrame = SERIES_POS;
  ENDFRAME = (STARTFRAME + VAD_SIZE) % RB_SIZE_FRAMING;
  let image = [];
  let curpos = STARTFRAME;

  for (let idx = 0; idx < VAD_SIZE; idx++) {
    image[idx] = Array.from(LOG_MEL_RAW[curpos]);

    curpos++;
    if (curpos >= RB_SIZE_FRAMING) {
      curpos = 0;
    }
    if (curpos == ENDFRAME) {
      break;
    }
  }

  if (MEAN_NORMALIZE) {
    utils.meanNormalize(image);
  } else {
    utils.standardize(image);
  }

  label = label.split(' ')[1]; // lovely ... :(
  dataset_vad.addImage(image, label);

  e.target.labels[0].innerHTML = `${dataset_vad.getNumImages(label)}`;
  console.log('recording finished');
} // end recording

// Event listeners for record buttons VAD
for (let idx = 0; idx < record_btns_vad.length; idx++) {
  record_btns_vad[idx].addEventListener('click', (e) => {
    toggleRecordButtons_vad(true);

    let label = record_btns_vad[idx].id;

    let N = 0;
    let intervall = setInterval(() => {
      N++;
      if (N >= VAD_N_SNAPSHOTS) {
        clearInterval(intervall);
        toggleRecordButtons_vad(false);
      }
      console.log('record vad:', label);
      STARTFRAME = Data_Pos;
      ENDFRAME = undefined;
      record_vad(e, label);
    }, VAD_TIME * 1000);
  });
}

function toggleRecordButtons(flag) {
  for (let idx = 0; idx < record_btns.length; idx++) {
    record_btns[idx].disabled = flag;
  }
}

function toggleRecordButtons_vad(flag) {
  for (let idx = 0; idx < record_btns_vad.length; idx++) {
    record_btns_vad[idx].disabled = flag;
  }
}

function togglePredictButton(flag) {
  predict_btn.disabled = flag;
}
togglePredictButton(false);

function toggleButtons(flag) {
  toggleRecordButtons(flag);
  showImages_btn.disabled = flag;
  train_btn.disabled = flag;
}

/**
 * Create Network and attach training to training button
 */
train_btn.addEventListener('click', async () => {
  toggleButtons(true);
  nn = createNetwork(RECORD_SIZE_FRAMING, N_MEL_FILTER, NCLASSES);
  model = nn.getModel();
  tfvis.show.modelSummary({ name: 'Model Summary' }, model);
  trained_data = dataset.getData();
  await nn.train(trained_data.x, trained_data.y, model);
  is_trained = true;
  console.log('training finished');

  showAccuracy();
  showConfusion();

  togglePredictButton(false);
  //TODO: toggleAccuracy
});

/**
 * Create Network for VAD and attach training to training button
 */
train_btn_vad.addEventListener('click', async () => {

  if (model_vad == undefined) {
    model_vad = nn_vad.getModel();
  } else {
    //nn_vad.freezeModelforTransferLearning(model_vad);
    console.log('continue training with new dataset');
    nn_vad.compile_model(model_vad);
  }

  tfvis.show.modelSummary({ name: 'Model Summary' }, model_vad);
  trained_data_vad = dataset_vad.getData();
  await nn_vad.train(trained_data_vad.x, trained_data_vad.y, model_vad);
  is_trained_vad = true;
  console.log('training finished');

  showAccuracy_vad();
  showConfusion_vad();
  //TODO: toggleAccuracy
});

/**
 * Predict section
 */
function predict(endFrame) {
  //console.log(utils.getTime());

  let startFrame = endFrame - RECORD_SIZE_FRAMING;
  if (startFrame < 0) {
    startFrame = RB_SIZE_FRAMING + startFrame;
  }

  console.log(utils.getTime(), 'voice activity detected:', VAD_AVERAGE);
  if (VAD_AVERAGE > VAD_THRESHOLD) {
    suspend = PRED_SUSPEND;

    let image = [];
    curpos = startFrame;
    for (let idx = 0; idx < RECORD_SIZE_FRAMING; idx++) {
      image[idx] = Array.from(LOG_MEL_RAW[curpos]);
      PRED_IMG[idx] = Array.from(LOG_MEL[curpos]);

      curpos++;
      if (curpos >= RB_SIZE_FRAMING) {
        curpos = 0;
      }
      if (curpos == endFrame) {
        break;
      }
    }

    //check which what option the nn was trained!
    if (MEAN_NORMALIZE) {
      utils.meanNormalize(image);
    } else {
      utils.standardize(image);
    }

    let x = tf.tensor2d(image).reshape([1, RECORD_SIZE_FRAMING, N_MEL_FILTER, 1]);

    utils.assert(model != undefined, 'not trained yet?');

    model
      .predict(x)
      .data()
      .then((result) => {
        showPrediction(result);
      })
      .catch((err) => {
        console.log(err);
      });

    x.dispose();
  } else {
    suspend = 1;
  }

  setTimeout(() => {
    tf.tidy(() => {
      predict(Data_Pos);
    });
  }, PRED_INTERVALL * suspend);
}

function showPrediction(result) {
  const inputs = dataset.getInputs();
  utils.assert(result.length == inputs.length);

  const maxIdx = utils.indexOfMax(result);
  console.log('top result', maxIdx, result[maxIdx]);
  
  let list = document.getElementById('result');
  list.innerHTML = '';

  for (let idx = 0; idx < result.length; idx++) {
    let entry = document.createElement('li');
    let span = document.createElement('span');
    let textNode = document.createTextNode(`${inputs[idx].label}: ${result[idx].toFixed(2)}`);
    if (idx == maxIdx) {
      span.style.color = 'red';
    }
    span.appendChild(textNode);
    entry.appendChild(span);
    list.appendChild(entry);

    const rectHeight = canvas_pred_meter[idx].height;
    const rectWidth = canvas_pred_meter[idx].width;
    context_pred_meter[idx].clearRect(0, 0, rectWidth, rectHeight);
    
    if (result[idx] > VAD_THRESHOLD) {
      context_pred_meter[idx].fillStyle = "red";
    } else {
      context_pred_meter[idx].fillStyle = "green";
    }
    context_pred_meter[idx].fillRect(0, 0, result[idx] * rectWidth, rectHeight);
  }

  //
  
  if (result[maxIdx] > TRESHOLD && maxIdx != 0) {
    let div = document.getElementById('topresult');
    div.innerHTML = '';
    let entry = document.createElement('p');
    let span = document.createElement('span');
    let textNode;
    textNode = document.createTextNode(
      `last recognized class (threshold>${TRESHOLD}) except class1: ${inputs[maxIdx].label}`
    );
    span.appendChild(textNode);
    entry.appendChild(span);
    div.appendChild(entry);
  }
}

predict_btn.addEventListener('click', () => {
  // setInterval(() => {
  //   tf.tidy(() => {
  //     predict(Data_Pos);
  //   });
  // }, PRED_INTERVALL * suspend);

  tf.tidy(() => {
    predict(Data_Pos);
  });
  //TODO: disable btn
});

// who understands what is happening here, feel free to explain it to me :)
function transpose(a) {
  return a[0].map((_, c) => a.map((r) => utils.rangeMap(r[c], -1, 1, 0, 255)));
}

showImages_btn.addEventListener('click', async () => {
  const surface = tfvis.visor().surface({
    name: 'Recorded Images',
    tab: 'Input Data',
  });
  const drawArea = surface.drawArea; // Get the examples
  drawArea.innerHTML = '';
  const MAX = 20;

  const inputs = dataset.getInputs();

  for (let classIdx = 0; classIdx < inputs.length; classIdx++) {
    const p = document.createElement('p');
    p.innerText = inputs[classIdx].label;
    drawArea.appendChild(p);
    for (let idx = 0; idx < inputs[classIdx].data.length; idx++) {
      if (idx >= MAX) {
        break;
      }
      const canvas = document.createElement('canvas');
      canvas.width = RECORD_SIZE_FRAMING + 2;
      canvas.height = N_MEL_FILTER + 2;
      canvas.style = 'margin: 1px; border: solid 1px';
      await tf.browser.toPixels(transpose(inputs[classIdx].data[idx]).reverse(), canvas);
      drawArea.appendChild(canvas);
    }
  }
});


/**
 * save VAD model to file
 */
const save_model_btn_vad = document.getElementById('save_model_btn_vad');
save_model_btn_vad.addEventListener('click', async () => {
  utils.assert(model_vad != undefined, 'vad model undefined');
  utils.assert(is_trained_vad == true, 'not trained yet?');
  const filename = document.getElementById('vad_model_name').value;
  console.log(await model_vad.save(`downloads://${filename}`));
});


/**
 * load VAD model
 * user has to select json and bin file
 */
const load_model_file_vad = document.getElementById('download-model-vad');
load_model_file_vad.addEventListener('change', async (e) => {

  utils.assert(e.target.files.length == 2, "select one json and one bin file for model");
  e.target.labels[1].innerHTML = '';

  let jsonFile;
  let binFile;

  if (e.target.files[0].name.split('.').pop() == 'json') {
    jsonFile = e.target.files[0];
    binFile = e.target.files[1];
  } else {
    jsonFile = e.target.files[1];
    binFile = e.target.files[0];
  }

  utils.assert(model_vad == undefined, 'vad model already defined?'); //overwrite????
  utils.assert(is_trained_vad == false, 'vad model already trained?');
  console.log('loading vad model from', jsonFile.name, binFile.name);

  e.target.labels[1].innerHTML = jsonFile.name + ', ' + binFile.name;

  model_vad = await tf.loadLayersModel(tf.io.browserFiles([jsonFile, binFile]));
  console.log(model_vad);
});


/** 
 * save recorded vad images
 * can be loaded and extended for further training
 */
const save_data_btn_vad = document.getElementById('save_data_btn_vad');
save_data_btn_vad.addEventListener('click', async () => {
  const filename = document.getElementById('vad_model_name').value;
  const inputs = dataset_vad.getInputs();
  console.log('saving vad data:', inputs.length);
  utils.download(JSON.stringify(inputs), `${filename}`, 'text/plain');
});

/**
 * Load previously recorded VAD images
 * clear all currently recorded images !
 * has to be the same number of classes and dimension
 */
const load_data_file_vad = document.getElementById('download-data-vad');
load_data_file_vad.addEventListener('change', (e) => {
  const file = e.target.files[0];
  console.log('loading vad date from', file.name);
  const reader = new FileReader();
  reader.addEventListener('load', (event) => {
    let res = event.target.result;
    let textByLine = res.split("\n");
    let newInputs = JSON.parse(textByLine);
    dataset_vad.clearInputs();
    dataset_vad.setInputs(newInputs);
    e.target.labels[1].innerHTML = file.name;
  });
  //reader.readAsDataURL(file);
  reader.readAsText(file);
});

/**
 * Accuracy and Confusion Matrix
 */
function doPrediction() {
  utils.assert(trained_data != undefined, 'not trained');

  const testxs = trained_data.x_validation;
  const labels = trained_data.y_validation.argMax([-1]);
  const preds = model.predict(testxs).argMax([-1]);
  testxs.dispose();
  return [preds, labels];
}

async function showAccuracy() {
  const [preds, labels] = doPrediction();

  const classAccuracy = await tfvis.metrics.perClassAccuracy(labels, preds);
  const container = {
    name: 'Accuracy',
    tab: 'Evaluation',
  };

  let classNames = [];
  const inputs = dataset.getInputs();
  for (let idx = 0; idx < inputs.length; idx++) {
    classNames.push(inputs[idx].label);
  }

  tfvis.show.perClassAccuracy(container, classAccuracy, classNames);
  labels.dispose();
}

async function showConfusion() {
  const [preds, labels] = doPrediction();
  const confusionMatrix = await tfvis.metrics.confusionMatrix(labels, preds);
  const container = {
    name: 'Confusion Matrix',
    tab: 'Evaluation',
  };
  let classNames = [];
  const inputs = dataset.getInputs();
  for (let idx = 0; idx < inputs.length; idx++) {
    classNames.push(inputs[idx].label);
  }
  tfvis.render.confusionMatrix(container, {
    values: confusionMatrix,
    tickLabels: classNames,
  });
  labels.dispose();
}

/**
 * Accuracy and Confusion Matrix Vad
 */
function doPrediction_vad() {
  utils.assert(trained_data_vad != undefined, 'not trained');

  const testxs = trained_data_vad.x_validation;
  const labels = trained_data_vad.y_validation.argMax([-1]);
  const preds = model_vad.predict(testxs).argMax([-1]);
  testxs.dispose();
  return [preds, labels];
}

async function showAccuracy_vad() {
  const [preds, labels] = doPrediction_vad();

  const classAccuracy = await tfvis.metrics.perClassAccuracy(labels, preds);
  const container = {
    name: 'Accuracy VAD',
    tab: 'Evaluation',
  };

  let classNames = [];
  const inputs = dataset_vad.getInputs();
  for (let idx = 0; idx < inputs.length; idx++) {
    classNames.push(inputs[idx].label);
  }

  tfvis.show.perClassAccuracy(container, classAccuracy, classNames);
  labels.dispose();
}

async function showConfusion_vad() {
  const [preds, labels] = doPrediction_vad();
  const confusionMatrix = await tfvis.metrics.confusionMatrix(labels, preds);
  const container = {
    name: 'Confusion Matrix VAD',
    tab: 'Evaluation',
  };
  let classNames = [];
  const inputs = dataset_vad.getInputs();
  for (let idx = 0; idx < inputs.length; idx++) {
    classNames.push(inputs[idx].label);
  }
  tfvis.render.confusionMatrix(container, {
    values: confusionMatrix,
    tickLabels: classNames,
  });
  labels.dispose();
}

document.querySelector('#show-accuracy').addEventListener('click', () => showAccuracy());
document.querySelector('#show-confusion').addEventListener('click', () => showConfusion());
document.querySelector('#show-accuracy-vad').addEventListener('click', () => showAccuracy_vad());
document.querySelector('#show-confusion-vad').addEventListener('click', () => showConfusion_vad());
