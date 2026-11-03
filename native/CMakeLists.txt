cmake_minimum_required(VERSION 3.18)
project(mrq_juce_native)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- JUCE, baixado sob demanda pro build/_deps (fora do controle de versão e
# fora dos snapshots do workspace, ver nota em native/README.md) ---
include(FetchContent)
FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.6
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

# --- node-addon-api / Node-API: cmake-js define estas variáveis (ver
# package.json -> "cmake-js compile") ---
include_directories(${CMAKE_JS_INC})
if(DEFINED CMAKE_JS_SRC)
  set(NODE_API_SRC ${CMAKE_JS_SRC})
endif()

execute_process(
  COMMAND node -p "require('node-addon-api').include.replace(/\"/g, '')"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
include_directories(${NODE_ADDON_API_DIR})

add_library(${PROJECT_NAME} SHARED
  src/binding.cpp
  src/JuceAudioEngine.cpp
  ${NODE_API_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_DISABLE_CPP_EXCEPTIONS=0
  JUCE_STANDALONE_APPLICATION=0
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_MODAL_LOOPS_PERMITTED=0
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  juce::juce_core
  juce::juce_events
  juce::juce_audio_basics
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_dsp
  ${CMAKE_JS_LIB}
)

juce_generate_juce_header(${PROJECT_NAME})
