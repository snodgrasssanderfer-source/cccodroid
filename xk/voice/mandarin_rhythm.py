"""念出来以后再加工（主人电脑上的 Codex 调音时加的，11-04 合进来，只给 config.json 的 gsv_rhythm 里写了的人用）：
tempo：不变调地改语速（ffmpeg rubberband）；pause_cap：句子里长于 0.55 秒的停顿收到这么长；
equalizer：一段峰值均衡（主人选的：小克 1kHz、Q 1.2、-2dB，鼻音轻一点），音量按原来的 RMS 对齐、峰值不过 1。
tempo 和 equalizer 要 ffmpeg。"""
import io
import subprocess

import numpy as np
import soundfile as sf


def shorten_internal_pauses(signal, rate, target=.36):
    hop = round(rate*.005)
    frame = round(rate*.015)
    frames = np.lib.stride_tricks.sliding_window_view(signal,frame)[::hop]
    rms = np.sqrt((frames**2).mean(axis=1))
    threshold = max(.0008,float(np.percentile(rms,90))*.025)
    active = np.flatnonzero(rms>threshold)
    chunks=[]
    cursor=0
    for left,right in zip(active[:-1],active[1:]):
        lo=(left*hop+frame)/rate
        hi=right*hop/rate
        if hi-lo > .55:
            start=round((lo+target/2)*rate)
            stop=round((hi-target/2)*rate)
            chunks.append(signal[cursor:start])
            cursor=stop
    chunks.append(signal[cursor:])
    return np.concatenate(chunks)


def adjust_audio(raw, settings, ffmpeg):
    tempo=float(settings.get('tempo',1))
    if tempo != 1:
        result=subprocess.run([str(ffmpeg),'-hide_banner','-loglevel','error','-f','wav','-i','pipe:0',
            '-af',f'rubberband=tempo={tempo}:pitch=1:transients=crisp:detector=soft:phase=laminar',
            '-f','wav','-acodec','pcm_s16le','pipe:1'],input=raw,stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        raw=result.stdout
    audio,rate=sf.read(io.BytesIO(raw),dtype='float32')
    audio=shorten_internal_pauses(audio,rate,float(settings.get('pause_cap',.36)))
    equalizer=settings.get('equalizer')
    if equalizer:
        source_rms=float(np.sqrt(np.mean(audio**2)))
        intermediate=io.BytesIO()
        sf.write(intermediate,audio,rate,format='WAV',subtype='PCM_16')
        filter_text=(f"equalizer=f={equalizer['frequency_hz']}:t=q:"
                     f"w={equalizer['q']}:g={equalizer['gain_db']}")
        result=subprocess.run([str(ffmpeg),'-hide_banner','-loglevel','error','-f','wav','-i','pipe:0',
            '-af',filter_text,'-f','wav','-acodec','pcm_f32le','pipe:1'],input=intermediate.getvalue(),
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        audio,_=sf.read(io.BytesIO(result.stdout),dtype='float32')
        output_rms=float(np.sqrt(np.mean(audio**2)))
        peak=float(np.max(np.abs(audio)))
        if output_rms>0 and peak>0:
            audio*=min(source_rms/output_rms,.999/peak)
    output=io.BytesIO()
    sf.write(output,audio,rate,format='WAV',subtype='PCM_16')
    return output.getvalue()
