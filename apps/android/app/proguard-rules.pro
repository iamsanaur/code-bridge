# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class dev.codebridge.core.** { *** Companion; }
-keepclasseswithmembers class dev.codebridge.core.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class dev.codebridge.core.**$$serializer { *; }
# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
