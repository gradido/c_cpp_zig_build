#include "matrix.h"

namespace matrix {

Matrix::Matrix(std::size_t rows, std::size_t cols)
    : rows_(rows), cols_(cols), data_(rows * cols, 0.0) {}

double& Matrix::at(std::size_t row, std::size_t col) {
  return data_[row * cols_ + col];
}

double Matrix::at(std::size_t row, std::size_t col) const {
  return data_[row * cols_ + col];
}

Matrix Matrix::multiply(const Matrix& other) const {
  if (cols_ != other.rows_) {
    throw std::invalid_argument("matrix shapes do not line up for multiplication");
  }

  Matrix result(rows_, other.cols_);
  for (std::size_t i = 0; i < rows_; ++i) {
    for (std::size_t k = 0; k < cols_; ++k) {
      const double left = at(i, k);
      if (left == 0.0) continue;  // the common case in sparse-ish input
      for (std::size_t j = 0; j < other.cols_; ++j) {
        result.at(i, j) += left * other.at(k, j);
      }
    }
  }
  return result;
}

}  // namespace matrix
