#include "JuceAudioEngine.h"

namespace mrq {

JuceAudioEngine::JuceAudioEngine() {
  testGain.reset(44100.0, 0.02); // 20ms de rampa, evita clique no on/off do tom de teste
}

JuceAudioEngine::~JuceAudioEngine() {
  stop();
}

std::vector<std::string> JuceAudioEngine::listOutputDevices() {
  std::vector<std::string> result;
  for (auto* type : deviceManager.getAvailableDeviceTypes()) {
    type->scanForDevices();
    for (auto& name : type->getDeviceNames(false)) {
      result.push_back(name.toStdString());
    }
  }
  return result;
}

std::string JuceAudioEngine::start(const std::string& deviceName) {
  juce::String error;
  if (deviceName.empty()) {
    error = deviceManager.initialiseWithDefaultDevices(0, 2);
  } else {
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager.getAudioDeviceSetup(setup);
    setup.outputDeviceName = juce::String(deviceName);
    error = deviceManager.setAudioDeviceSetup(setup, true);
  }
  if (error.isNotEmpty()) {
    return error.toStdString();
  }
  deviceManager.addAudioCallback(this);
  running = true;
  return {};
}

void JuceAudioEngine::stop() {
  if (!running.exchange(false)) return;
  deviceManager.removeAudioCallback(this);
  deviceManager.closeAudioDevice();
}

void JuceAudioEngine::noteOnTest(double freqHz) {
  testOsc.setFrequency(static_cast<float>(freqHz), true);
  noteActive = true;
  testGain.setTargetValue(0.2f); // baixo de propósito, é só um tom de teste
}

void JuceAudioEngine::noteOffTest() {
  noteActive = false;
  testGain.setTargetValue(0.0f);
}

void JuceAudioEngine::audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                                         int /*numInputChannels*/,
                                                         float* const* outputChannelData,
                                                         int numOutputChannels,
                                                         int numSamples,
                                                         const juce::AudioIODeviceCallbackContext&) {
  for (int sample = 0; sample < numSamples; ++sample) {
    const float g = testGain.getNextValue();
    const float value = testOsc.processSample(0.0f) * g;
    for (int ch = 0; ch < numOutputChannels; ++ch) {
      if (outputChannelData[ch] != nullptr) {
        outputChannelData[ch][sample] = value;
      }
    }
  }
}

void JuceAudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
  const double sr = device->getCurrentSampleRate();
  const int bs = device->getCurrentBufferSizeSamples();
  sampleRate = sr;
  bufferSize = bs;
  juce::dsp::ProcessSpec spec { sr, static_cast<juce::uint32>(bs), 2 };
  testOsc.prepare(spec);
  testGain.reset(sr, 0.02);
}

void JuceAudioEngine::audioDeviceStopped() {
  sampleRate = 0.0;
  bufferSize = 0;
}

} // namespace mrq
