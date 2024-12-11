import './index.css';


declare global {
    interface Window {
        electron: any;
    }
}


/*


console.log('👋 This message is being logged by "renderer.js", included via webpack');

let mediaRecorder: any;
let recordedChunks:any = [];

// Buttons
const videoElement = document.querySelector('#video') as HTMLVideoElement;


// const startBtn = document.getElementById('startBtn');
// startBtn.onclick = e => {
//   startRecording();
//   startBtn.innerText = 'Recording';
// };

// const stopBtn = document.getElementById('stopBtn');

// stopBtn.onclick = e => {
//   mediaRecorder.stop();
//   startBtn.innerText = 'Start';
// };

// const videoSelectBtn = document.getElementById('videoSelectBtn');
// videoSelectBtn.onclick = getVideoSources;

// const selectMenu = document.getElementById('selectMenu') as any



const selectMenu:any = null;

window.addEventListener('DOMContentLoaded', async () => {
    await getVideoSources()
    await startRecording()
})

async function getVideoSources() {
    const inputSources = await window.electron.getSources()
  
    inputSources.forEach((source:any) => {
      const element = document.createElement("option")
      element.value = source.id
      element.innerHTML = source.name
      selectMenu?.appendChild(element)
    });
  }


  async function startRecording() {
    let screenId = selectMenu ? selectMenu?.options[selectMenu?.selectedIndex].value : null
    screenId = "screen:1:0"
    

    console.log("screenId", screenId)


    const constraints:any = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screenId
        }
      }
    };
  
    // Create a Stream
    const stream = await navigator.mediaDevices
      .getUserMedia(constraints);
  
    // Preview the source in a video element
    videoElement.srcObject = stream;
    await videoElement.play();
  
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9', videoBitsPerSecond: 2500000 });
    stream.getVideoTracks()[0].applyConstraints({ frameRate: 60 });
    mediaRecorder.ondataavailable = onDataAvailable;
    mediaRecorder.onstop = stopRecording;
    mediaRecorder.start();
}

function onDataAvailable(e:any) {
    recordedChunks.push(e.data);
}


async function stopRecording() {
    videoElement.srcObject = null

    const blob = new Blob(recordedChunks, {
      type: 'video/webm; codecs=vp9'
    });
  
    const buffer = Buffer.from(await blob.arrayBuffer());
    recordedChunks = []

    const { canceled, filePath } =  await ipcRenderer.invoke('showSaveDialog')
    if(canceled) return
  
    if (filePath) {
      //writeFile(filePath, buffer, () => console.log('video saved successfully!'));
    }
}

*/