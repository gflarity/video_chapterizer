import { StringReader } from "https://deno.land/std@0.178.0/io/string_reader.ts";
import { walk, } from "https://deno.land/std@0.177.0/fs/walk.ts";
import * as path from "https://deno.land/std@0.170.0/path/mod.ts"

const file = "Mkv\ Sample.mkv"

class KeyFrame {
  pts_time: number;
  pkt_pos: number;

  static frameRegEX = /.*pts_time=(\d+).*pkt_pos=(\d+).*/su;

  constructor(frameData: string) {
    const matches = frameData.match(KeyFrame.frameRegEX)
    if (!matches || matches.length < 3) {
      throw new Error("couldn't parse framedata")
    }
    this.pts_time = parseInt(matches[1]);
    this.pkt_pos = parseInt(matches[2]);
  }
}

class KeyFrameCollection {
  private keyFrames: KeyFrame[]; 
  
  constructor(keyFrames: KeyFrame[]) {
    this.keyFrames = keyFrames;
  }

  /* 
    Generate a chapter document/string from key frame start/end times. 

    Example: 

    [CHAPTER]
    TIMEBASE=1/1000
    START=0
    END=180000
    title=Chapter 1
    [CHAPTER]
    TIMEBASE=1/1000
    START=180000
    END=360000
    title=Chapter 2
    [CHAPTER]
    TIMEBASE=1/1000
    START=360000 
    END=540000
    title=Chapter 3
    [CHAPTER]
  */
  public generateChapterMetadata(): string {
    let chapterString = ";FFMETADATA1\n";
    let lastFrame: KeyFrame | undefined;
    for (const frame of this.keyFrames) {
      if (!lastFrame) {
        chapterString += `[CHAPTER]\n`
        chapterString += `TIMEBASE=1/1\n`
        chapterString += `START=0\n`
        chapterString += `END=${frame.pts_time}\n`
        chapterString += `title=Chapter 1\n`
      } else {
        chapterString += `[CHAPTER]\n`
        chapterString += `TIMEBASE=1/1\n`
        chapterString += `START=${lastFrame.pts_time}\n`
        chapterString += `END=${frame.pts_time}\n`
        chapterString += `title=Chapter ${this.keyFrames.indexOf(frame) + 1}\n`
      }
      lastFrame = frame;
    }
    return chapterString;
  }
}

type KFPromiseResolve = (keyFrames: KeyFrameCollection) => void;
type KFPromiseReject = (reason: Error) => void;

class KeyFrameCollector {
  private stringBuffer = ""
  private textDecoder = new TextDecoder();
  private textEncoder = new TextEncoder();
  private frameRegEx = /\[FRAME\](.*key_frame=(\d).*)\[\/FRAME\]/su;
  private keyFrames: KeyFrame[] = [];
  private completionPromise: Promise<KeyFrameCollection>;
  private resolve!: (KeyFrameCollection: KeyFrameCollection) => void;
  private reject!: (reason: Error) => void;  
  private encoder = new TextEncoder();

  constructor() {
    const self = this;
    this.completionPromise = new Promise((resolve: KFPromiseResolve, reject: KFPromiseReject) => {
      self.resolve = resolve;
      self.reject = reject;
    }) 
  }
  start(controller: WritableStreamDefaultController) {
    const self = this;
  } 

  write(chunk : Uint8Array, controller: WritableStreamDefaultController) {
    this.stringBuffer += this.textDecoder.decode(chunk)

    let matches: RegExpMatchArray | null;
    while ((matches = this.stringBuffer.match(this.frameRegEx))?.length === 3) {
      // pass on the key frames
      if (matches![2] === "1") {
        this.keyFrames.push(new KeyFrame(matches![1]))
        //console.error(this.keyFrames[this.keyFrames.length - 1])
        Deno.stdout.write(this.encoder.encode("."))
      }
      // remove the frame regardless of contents
      this.stringBuffer = this.stringBuffer.replace(this.frameRegEx, "")
    }
  }

  // returns a promise that is resolved when the frames have been processes
  async processingDone(): Promise<KeyFrameCollection> {
    return this.completionPromise;
  }

  close() {
    this.resolve(new KeyFrameCollection(this.filterFrames()));
  }

  abort(reason: Error) { 
    this.reject(reason)
  }

  // return frames from keyFrames every 180 seconds (3 minutes)
  filterFrames(): KeyFrame[] {
    const filteredFrames: KeyFrame[] = [];
    let lastFrame: KeyFrame = this.keyFrames[0];
    for (const frame of this.keyFrames) {
      if (frame.pts_time - lastFrame.pts_time > 180) {
        filteredFrames.push(frame)
        lastFrame = frame;
      }
    }
    return filteredFrames;
  }
}

async function chapterize(inFile: string, outFile: string) {
  const keyFrameCollector = new KeyFrameCollector();
  const kfStream = new WritableStream(keyFrameCollector)
  
  console.log(`Calculating chapters for ${inFile}`)
  const keyframeProcess = Deno.run({cmd: ["ffprobe", "-select_streams",  "v", "-show_frames", "-skip_frame", "nokey", inFile], stdout: "piped", stderr: "null"})
  keyframeProcess.stdout?.readable.pipeTo(kfStream)
  const keyFrameCollection = await keyFrameCollector.processingDone();

  const chapterizeProcess = Deno.run({ 
    cmd: ["ffmpeg", "-i", inFile, "-i", "-", "-map_chapters", "1", "-codec", "copy", outFile], 
    stdin: "piped",
    stdout: "null", 
    stderr: "piped"})
  

  chapterizeProcess.stdin.write(new TextEncoder().encode(keyFrameCollection.generateChapterMetadata()))
  chapterizeProcess.stdin.close();
  const promiseStatus = await chapterizeProcess.status();
  if (!promiseStatus.success) {
    const output = await chapterizeProcess.stderrOutput();
    throw new Error("could not write chapters, here's the stderr: \n" + new TextDecoder().decode(output));
  }
}


if (!Deno.args[0] || !Deno.args[1] ) {
  console.log("usage: deno run --allow-read --allow-run --allow-write chapterize.ts <source dir> <destination dir>")
  Deno.exit(1);
}

// test that destDir exists, if it doesn't make it so
try {
  await Deno.stat(Deno.args[1]);
} catch (e) {
  // make the directory since it doesn't exist
  await Deno.mkdir(Deno.args[1]);  
}

const sourceDir = Deno.realPathSync(Deno.args[0]);
const destDir: string = Deno.realPathSync(Deno.args[1]);

console.log(`source: ${sourceDir} destination: ${destDir}`)
Deno.mkdir(destDir, {recursive:true})

// recursively walk through a directory looking for .mkv and .mp4 files
for await (const entry of walk(sourceDir, { match: [new RegExp("(mp4|mkv)$", "i")] })) {
  const sourcePath =  entry.path;
  const destPath = sourcePath.replace(sourceDir, destDir);
  console.log(`${sourcePath}->${destPath}`);
  try {
    await chapterize(sourcePath, destPath);    
  } catch (e) {
    console.error(e);    
  }
}


