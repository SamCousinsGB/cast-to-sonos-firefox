/**
 * MAIN-world lightweight Web Audio tap.
 * Captures audio on websites that synthesize or route sound purely via Web Audio API
 * (e.g. web synths, games, DAWs, custom audio players) without HTML <audio>/<video> elements.
 * Zero overhead until activated by the extension content script.
 */
(() => {
  if (window.__castToSonosWebAudioHooked) return;
  window.__castToSonosWebAudioHooked = true;

  const OriginalConnect = AudioNode.prototype.connect;
  const ctxMap = new WeakMap(); // AudioContext -> { tapGain, localGain, processor, connectedNodes }
  let tapActive = false;
  let muteLocal = true;
  const activeContexts = new Set();

  function getOrCreateTap(ctx) {
    if (ctxMap.has(ctx)) return ctxMap.get(ctx);

    const state = {
      ctx,
      localGain: ctx.createGain(),
      tapBus: ctx.createGain(),
      processor: null,
      sinkGain: ctx.createGain(),
    };

    state.localGain.gain.value = tapActive && muteLocal ? 0 : 1;
    state.sinkGain.gain.value = 0;

    // Connect localGain -> real destination using original unpatched connect
    OriginalConnect.call(state.localGain, ctx.destination);
    OriginalConnect.call(state.sinkGain, ctx.destination);

    ctxMap.set(ctx, state);
    activeContexts.add(state);

    if (tapActive) {
      enableProcessor(state);
    }
    return state;
  }

  function enableProcessor(state) {
    if (state.processor) return;
    try {
      const processor = state.ctx.createScriptProcessor(2048, 2, 2);
      processor.onaudioprocess = (event) => {
        if (!tapActive) return;
        const input = event.inputBuffer;
        const left = input.getChannelData(0);
        const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;

        // Check if non-silent to avoid fighting HTMLMediaElement capture
        let peak = 0;
        const interleaved = new Int16Array(left.length * 2);
        for (let i = 0; i < left.length; i++) {
          const l = Math.max(-1, Math.min(1, left[i]));
          const r = Math.max(-1, Math.min(1, right[i]));
          const abs = Math.max(Math.abs(l), Math.abs(r));
          if (abs > peak) peak = abs;
          interleaved[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
          interleaved[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
        }
        if (peak < 0.0001) return;

        window.postMessage(
          {
            __castToSonos: true,
            type: 'webaudio-pcm',
            sampleRate: state.ctx.sampleRate,
            pcm: interleaved.buffer,
          },
          '*',
          [interleaved.buffer]
        );
      };

      OriginalConnect.call(state.tapBus, processor);
      OriginalConnect.call(processor, state.sinkGain);
      state.processor = processor;
    } catch {
      // ignore contexts that cannot create script processor
    }
  }

  function disableProcessor(state) {
    if (!state.processor) return;
    try {
      state.tapBus.disconnect(state.processor);
      state.processor.disconnect();
    } catch {
      // ignore
    }
    state.processor = null;
  }

  // Patch AudioNode.prototype.connect so connections targeting ctx.destination pass through our tap
  AudioNode.prototype.connect = function patchedConnect(destination, ...rest) {
    try {
      if (
        destination &&
        this.context &&
        destination === this.context.destination &&
        !this.__castToSonosInternal
      ) {
        const state = getOrCreateTap(this.context);
        state.localGain.__castToSonosInternal = true;
        state.tapBus.__castToSonosInternal = true;
        OriginalConnect.call(this, state.tapBus, ...rest);
        return OriginalConnect.call(this, state.localGain, ...rest);
      }
    } catch {
      // fall back to original connect
    }
    return OriginalConnect.call(this, destination, ...rest);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.__castToSonos) return;
    const msg = event.data;

    if (msg.type === 'webaudio-control') {
      tapActive = Boolean(msg.active);
      muteLocal = msg.muteLocal !== false;

      for (const state of activeContexts) {
        try {
          state.localGain.gain.value = tapActive && muteLocal ? 0 : 1;
          if (tapActive) enableProcessor(state);
          else disableProcessor(state);
        } catch {
          // ignore closed contexts
        }
      }
    }
  });
})();
