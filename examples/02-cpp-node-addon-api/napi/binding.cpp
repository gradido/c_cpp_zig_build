// The bindings, written with node-addon-api.
//
// node-addon-api is a C++ wrapper over the C Node-API. It is not part of
// zig-native-build: install it in the project that wants it, and the build
// picks up its headers automatically.
//
//   npm i -D node-addon-api

#include <napi.h>

#include <vector>

#include "matrix.h"

namespace {

/// Turns a JS array of arrays into a Matrix, complaining precisely when it is
/// not one.
matrix::Matrix FromJs(const Napi::Env& env, const Napi::Value& value, const char* what) {
  if (!value.IsArray()) {
    throw Napi::TypeError::New(env, std::string(what) + " must be an array of rows");
  }
  const Napi::Array rows = value.As<Napi::Array>();
  if (rows.Length() == 0) {
    throw Napi::TypeError::New(env, std::string(what) + " must have at least one row");
  }

  const Napi::Value first = rows.Get(0u);
  if (!first.IsArray()) {
    throw Napi::TypeError::New(env, std::string(what) + " rows must be arrays");
  }
  const std::size_t cols = first.As<Napi::Array>().Length();

  matrix::Matrix result(rows.Length(), cols);
  for (std::uint32_t i = 0; i < rows.Length(); ++i) {
    const Napi::Value row = rows.Get(i);
    if (!row.IsArray() || row.As<Napi::Array>().Length() != cols) {
      throw Napi::TypeError::New(env, std::string(what) + " rows must all be the same length");
    }
    const Napi::Array cells = row.As<Napi::Array>();
    for (std::uint32_t j = 0; j < cols; ++j) {
      result.at(i, j) = cells.Get(j).ToNumber().DoubleValue();
    }
  }
  return result;
}

Napi::Array ToJs(const Napi::Env& env, const matrix::Matrix& value) {
  Napi::Array rows = Napi::Array::New(env, value.rows());
  for (std::size_t i = 0; i < value.rows(); ++i) {
    Napi::Array cells = Napi::Array::New(env, value.cols());
    for (std::size_t j = 0; j < value.cols(); ++j) {
      cells.Set(static_cast<std::uint32_t>(j), Napi::Number::New(env, value.at(i, j)));
    }
    rows.Set(static_cast<std::uint32_t>(i), cells);
  }
  return rows;
}

Napi::Value Multiply(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    throw Napi::TypeError::New(env, "multiply(a, b) expects two matrices");
  }

  const matrix::Matrix a = FromJs(env, info[0], "a");
  const matrix::Matrix b = FromJs(env, info[1], "b");

  try {
    return ToJs(env, a.multiply(b));
  } catch (const std::invalid_argument& error) {
    // A C++ exception crossing into JS has to become a JS exception; letting
    // it escape would take the process down.
    throw Napi::Error::New(env, error.what());
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("multiply", Napi::Function::New(env, Multiply));
  return exports;
}

}  // namespace

NODE_API_MODULE(matrix_addon, Init)
