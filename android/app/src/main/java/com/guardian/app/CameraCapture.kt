package com.guardian.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner

/**
 * Takes a single still photo with no preview surface, straight to JPEG bytes.
 * Must be invoked with a LifecycleOwner (the foreground service is one).
 */
object CameraCapture {

    fun take(
        ctx: Context,
        owner: LifecycleOwner,
        front: Boolean = true,
        onJpeg: (ByteArray?) -> Unit
    ) {
        Handler(Looper.getMainLooper()).post {
            val future = ProcessCameraProvider.getInstance(ctx)
            future.addListener({
                try {
                    val provider = future.get()
                    val capture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .build()
                    val selector =
                        if (front) CameraSelector.DEFAULT_FRONT_CAMERA
                        else CameraSelector.DEFAULT_BACK_CAMERA

                    provider.unbindAll()
                    provider.bindToLifecycle(owner, selector, capture)

                    capture.takePicture(
                        ContextCompat.getMainExecutor(ctx),
                        object : ImageCapture.OnImageCapturedCallback() {
                            override fun onCaptureSuccess(image: ImageProxy) {
                                val buf = image.planes[0].buffer
                                val bytes = ByteArray(buf.remaining())
                                buf.get(bytes)
                                image.close()
                                provider.unbindAll()
                                onJpeg(bytes)
                            }

                            override fun onError(exc: ImageCaptureException) {
                                provider.unbindAll()
                                onJpeg(null)
                            }
                        }
                    )
                } catch (e: Exception) {
                    onJpeg(null)
                }
            }, ContextCompat.getMainExecutor(ctx))
        }
    }
}
