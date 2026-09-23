# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file LICENSE.rst or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "C:/Users/Jordi/iot")
  file(MAKE_DIRECTORY "C:/Users/Jordi/iot")
endif()
file(MAKE_DIRECTORY
  "C:/Users/Jordi/iot/build/iot"
  "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix"
  "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix/tmp"
  "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix/src/iot-stamp"
  "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix/src"
  "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix/src/iot-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix/src/iot-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "C:/Users/Jordi/iot/build/_sysbuild/sysbuild/images/iot-prefix/src/iot-stamp${cfgdir}") # cfgdir has leading slash
endif()
