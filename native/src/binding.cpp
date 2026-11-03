// Ponte Node-API (N-API) entre o motor nativo JUCE (JuceAudioEngine) e o
// processo principal do Electron. Prova de conceito — ver comentário no
// topo de JuceAudioEngine.h pro escopo real disto (não é o rack completo).
#include <napi.h>
#include "JuceAudioEngine.h"
#include <juce_events/juce_events.h>
#include <memory>

namespace {

// juce::MessageManager precisa existir antes de qualquer objeto JUCE ser
// usado (timers internos, etc.) — inicializado uma única vez, no primeiro
// require() deste addon.
struct JuceBootstrap {
  JuceBootstrap() { juce::initialiseJuce_GUI(); }
  ~JuceBootstrap() { juce::shutdownJuce_GUI(); }
};
JuceBootstrap bootstrap;

std::unique_ptr<mrq::JuceAudioEngine> engine;

Napi::Value ListOutputDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!engine) engine = std::make_unique<mrq::JuceAudioEngine>();
  auto names = engine->listOutputDevices();
  Napi::Array arr = Napi::Array::New(env, names.size());
  for (size_t i = 0; i < names.size(); i++) {
    arr.Set(static_cast<uint32_t>(i), Napi::String::New(env, names[i]));
  }
  return arr;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!engine) engine = std::make_unique<mrq::JuceAudioEngine>();
  std::string deviceName;
  if (info.Length() > 0 && info[0].IsString()) {
    deviceName = info[0].As<Napi::String>().Utf8Value();
  }
  std::string error = engine->start(deviceName);
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, error.empty()));
  result.Set("error", Napi::String::New(env, error));
  result.Set("sampleRate", Napi::Number::New(env, engine->getSampleRate()));
  result.Set("bufferSize", Napi::Number::New(env, engine->getBufferSize()));
  return result;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  if (engine) engine->stop();
  return info.Env().Undefined();
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), engine && engine->isRunning());
}

Napi::Value GetSampleRate(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), engine ? engine->getSampleRate() : 0.0);
}

Napi::Value NoteOnTest(const Napi::CallbackInfo& info) {
  if (engine && info.Length() > 0 && info[0].IsNumber()) {
    engine->noteOnTest(info[0].As<Napi::Number>().DoubleValue());
  }
  return info.Env().Undefined();
}

Napi::Value NoteOffTest(const Napi::CallbackInfo& info) {
  if (engine) engine->noteOffTest();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("listOutputDevices", Napi::Function::New(env, ListOutputDevices));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isRunning", Napi::Function::New(env, IsRunning));
  exports.Set("getSampleRate", Napi::Function::New(env, GetSampleRate));
  exports.Set("noteOnTest", Napi::Function::New(env, NoteOnTest));
  exports.Set("noteOffTest", Napi::Function::New(env, NoteOffTest));
  return exports;
}

} // namespace

NODE_API_MODULE(mrq_juce_native, Init)
