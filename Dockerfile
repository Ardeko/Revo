# Build aşaması
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /app

COPY . .
RUN dotnet publish -c Release -o out

# Runtime aşaması
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/out .

# Render (ve çoğu PaaS) dinlenecek portu PORT ortam değişkeniyle veriyor.
# Kestrel varsayılan olarak 8080'i dinler; PORT farklıysa aşağıdaki satır onu
# devreye alır. Render'da ayrıca Environment > PORT ayarlanmış olabilir.
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
EXPOSE 8080

# "--web" ZORUNLU: bu argüman olmadan uygulama masaüstü moduna düşer ve
# konteynerde pencere açmaya çalışır. Program.cs ayrıca Windows dışında
# otomatik olarak sunucu moduna geçiyor, ama niyeti açıkça yazmak daha güvenli.
ENTRYPOINT ["dotnet", "RevoApp.dll", "--web"]
