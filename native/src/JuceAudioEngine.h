#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_dsp/juce_dsp.h>
#include <atomic>
#include <vector>
#include <string>

namespace mrq {

/**
 * Prova de conceito do motor de áudio nativo em JUCE pedida pelo usuário
 * ("reconstrua o rack todo com a tecnologia JUCE pra vermos se melhora").
 *
 * Isto NÃO é o motor completo do Rack (RackEngine.ts) reescrito — seria
 * semanas de trabalho real pra portar as 8 camadas, todos os formatos de
 * instrumento (SF2/NKI/EXS24/DX7/.mrq) e todos os ~15 efeitos por camada
 * (reverb/delay/chorus/flanger/phaser/bitcrusher/shimmer/compressor/EQ/
 * gate/drive/tremolo) pra DSP em C++. Isto é a fundação mínima que prova se
 * a abordagem é viável nesta máquina/pipeline antes de investir nisso:
 * - Abre um dispositivo de áudio real via juce::AudioDeviceManager (o mesmo
 *   caminho nativo que um VST/app standalone usaria — ASIO/CoreAudio/ALSA
 *   por baixo, bem diferente do Web Audio API do Chromium usado hoje).
 * - Gera um osciladorzinho simples (juce::dsp::Oscillator) como "nota de
 *   teste" pra provar que note-on/note-off disparam samples de áudio reais
 *   no callback de tempo real do JUCE, sem passar pelo thread principal do
 *   JS pra cada amostra (ao contrário do ScriptProcessorNode problemático
 *   que a gente acabou de tirar do caminho do bitcrusher no motor web).
 */
class JuceAudioEngine : public juce::AudioIODeviceCallback {
public:
  JuceAudioEngine();
  ~JuceAudioEngine() override;

  /** Lista os nomes dos dispositivos de saída de áudio disponíveis no SO. */
  std::vector<std::string> listOutputDevices();

  /** Abre o dispositivo de áudio (padrão do sistema se deviceName vazio). Retorna mensagem de erro (vazia = sucesso). */
  std::string start(const std::string& deviceName);

  void stop();

  bool isRunning() const { return running.load(); }
  double getSampleRate() const { return sampleRate.load(); }
  int getBufferSize() const { return bufferSize.load(); }

  /** Dispara o osciloscópio de teste numa frequência (Hz), com fade-in/out simples pra não estalar. */
  void noteOnTest(double freqHz);
  void noteOffTest();

  // --- juce::AudioIODeviceCallback ---
  void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                         int numInputChannels,
                                         float* const* outputChannelData,
                                         int numOutputChannels,
                                         int numSamples,
                                         const juce::AudioIODeviceCallbackContext& context) override;
  void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
  void audioDeviceStopped() override;

private:
  juce::AudioDeviceManager deviceManager;
  juce::dsp::Oscillator<float> testOsc { [](float x) { return std::sin(x); } };
  juce::LinearSmoothedValue<float> testGain { 0.0f };

  std::atomic<bool> running { false };
  std::atomic<double> sampleRate { 0.0 };
  std::atomic<int> bufferSize { 0 };
  std::atomic<bool> noteActive { false };
};

} // namespace mrq
