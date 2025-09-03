declare module 'canny-edge-detector' {
  /**
   * Detects edges in an image using the Canny edge detection algorithm
   */
  export default function cannyEdgeDetector(options: {
    /** Raw pixel data as Uint8ClampedArray */
    data: Uint8ClampedArray;
    /** Image width */
    width: number;
    /** Image height */
    height: number;
    /** Low threshold for edge detection */
    lowThreshold?: number;
    /** High threshold for edge detection */
    highThreshold?: number;
    /** Gaussian blur sigma */
    gaussianBlur?: number;
  }): Uint8ClampedArray;
}