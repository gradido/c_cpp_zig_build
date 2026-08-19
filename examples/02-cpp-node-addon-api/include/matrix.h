// A small C++ library. Nothing here knows that Node.js exists — that is the
// point of keeping the bindings in napi/.
#ifndef MATRIX_H
#define MATRIX_H

#include <cstddef>
#include <stdexcept>
#include <vector>

namespace matrix {

/// A dense row-major matrix of doubles.
class Matrix {
 public:
  Matrix(std::size_t rows, std::size_t cols);

  std::size_t rows() const { return rows_; }
  std::size_t cols() const { return cols_; }

  double& at(std::size_t row, std::size_t col);
  double at(std::size_t row, std::size_t col) const;

  /// Matrix product. Throws std::invalid_argument when the shapes disagree.
  Matrix multiply(const Matrix& other) const;

  const std::vector<double>& data() const { return data_; }

 private:
  std::size_t rows_;
  std::size_t cols_;
  std::vector<double> data_;
};

}  // namespace matrix

#endif  // MATRIX_H
