/**
 * NanoNavs Road Intelligence — Mobile Background Audio Keep-Alive
 *
 * Uses the HTML5 Web Audio API to play an inaudible buffer loop when a trip is active.
 * This instructs mobile operating systems (iOS Safari and Android Chrome) that the application
 * is an active media/navigation session, keeping background Geolocation watch, Web Workers,
 * and WebSocket streams alive when the user minimizes the browser or switches to another app.
 */

class BackgroundAudioKeepAlive {
  constructor() {
    this.audioCtx = null;
    this.oscillator = null;
    this.gainNode = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      this.audioCtx = new AudioContext();

      // Create an ultra-low inaudible oscillator (1Hz frequency, near-zero gain)
      this.oscillator = this.audioCtx.createOscillator();
      this.gainNode = this.audioCtx.createGain();

      this.oscillator.type = 'sine';
      this.oscillator.frequency.setValueAtTime(1.0, this.audioCtx.currentTime); // 1 Hz (sub-audible)
      this.gainNode.gain.setValueAtTime(0.0001, this.audioCtx.currentTime); // Inaudible volume

      this.oscillator.connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);

      this.oscillator.start();
      this.isRunning = true;
      console.log('🔊 Mobile background audio keep-alive activated');
    } catch (e) {
      console.warn('Audio keep-alive could not start:', e);
    }
  }

  stop() {
    if (!this.isRunning) return;
    try {
      if (this.oscillator) {
        this.oscillator.stop();
        this.oscillator.disconnect();
      }
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close();
      }
    } catch (e) {}
    this.isRunning = false;
    console.log('🔇 Mobile background audio keep-alive stopped');
  }
}

window.keepAliveEngine = new BackgroundAudioKeepAlive();

